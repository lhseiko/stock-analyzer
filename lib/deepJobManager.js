'use strict';
const healthMetrics = require('./healthMetrics'); // [② 健康指标] deep-analysis 缓存命中/未命中计数
/**
 * lib/deepJobManager.js — 深度分析后台任务状态机（20261111d · 链路 3 可测试化抽出 + B2 修复）
 * ------------------------------------------------------------------------------
 * 从 server.js:1625-1730 抽出，把 8 个外部依赖与超时常量改成构造参数注入，
 * 让 E2E 能用独立端口 + 受控 Promise 打真实路由 handler，而不必拉起整套 3300 行服务。
 * 生产默认值：300s 安全网 / 280s 内层 race / 5min done 结果保鲜 / 2000 任务上限。
 *
 * ── 状态机（修复后，scripts/test_deep_jobs_e2e.js 逐条实证）──────────────────
 *   [无 job / 终态已过期 / 错误已投递] --GET--> startJob --> running
 *   running          --底层完成--> done（结果落盘）
 *   running          --内层 280s / 外层 300s / 底层抛错--> error
 *   running          --并发或轮询复用--> 同一个 job（底层只跑 1 次，用户重点 §B）
 *   done             --TTL 内且缓存未命中--> 复用内存结果（轮询去重，不重复计算）
 *   done             --TTL 过期 / forceRefresh 语义变化--> 重建 job（状态清理）
 *   error            --首次投递 500--> 标记 errorDelivered（同一错误只报一次）
 *   error            --已投递后再次请求--> 重建 job（可重试，不永久 500）
 *   迟到结果（超时后底层仍算完）--> 只落盘 + 日志，绝不反向改已终态 job、不污染新 job
 *
 * ── B2 级缺陷清单（先由 E2E 跑红灯 27/5 实证，再统一修复）──────────────────
 *   B2-1 状态清理遗漏：done/error 终态 job 永久驻留 Map，缓存失效后仍被复用，
 *        且 Map 无上界。修复：doneTtlMs 惰性过期 + maxJobs 淘汰最旧终态。
 *   B2-2 超时后任务泄漏 / 结果丢弃：settled 后 `return` 把已算完的 5 分钟计算
 *        静默丢掉。修复：迟到结果照样落盘（不与新 job 抢状态），并打日志可观测。
 *   B2-3 定时器泄漏：Promise.race 的 280s 内层 timer 从不 clear，每次深度分析
 *        泄漏一个定时器。修复：finally clearTimeout(innerTimer)。
 *   B2-4 error 后永久 500：终态 error 被无限复用，用户不重启服务就无法重试。
 *        修复：错误投递一次后允许同参数请求重建 job。
 *   B2-5 并发竞态：forceRefresh 语义变化 / 重试覆盖旧 job 后，旧 job 的迟到结果
 *        会覆盖新结果或改错状态。修复：旧 job 标记 superseded，迟到结果直接丢弃。
 *   B2-6 落盘异常反向改状态：writeAnalysisCache 抛错会掉进 .catch，把已 done 的
 *        job 打成 error。修复：落盘 try/catch 隔离，失败只告警不改任务状态。
 *
 * 说明：响应 JSON 结构（running / done 结果体 / 500 error）零变化，前端无需改动；
 * 因此按 APP_VERSION 铁律**不 bump**（bump 会让 readAnalysisCache 的 appVersion 门控
 * 把全部深度分析磁盘缓存判失效，触发无谓的昂贵重算）。但 server.js 已改，需重启生效。
 */
function createDeepJobManager(deps) {
  const {
    deepAnalysis,
    getQuote,
    getHistory,
    detectMarket,
    readAnalysisCache,
    writeAnalysisCache,
    getLocalDocuments,
    attachDeepAICache,
    timeoutMs = 300000,      // 外层安全网：5min（E2E 注入 50ms / 300ms）
    innerTimeoutMs = 280000, // 内层 Promise.race：280s
    doneTtlMs = 5 * 60 * 1000, // done 结果内存保鲜期（缓存未命中时的轮询去重窗口）
    maxJobs = 2000,          // Map 上界，防止长期运行无限增长
    logger = console,
  } = deps;

  const jobs = new Map(); // symbol -> job

  async function runOnce(symbol, name) {
    const [quote, history] = await Promise.all([
      getQuote(symbol),
      getHistory(symbol, 'daily').catch(() => []),
    ]);
    if (!quote) return { __notFound: true };

    // B2-3：内层 race timer 必须无论胜负都 clear，否则每次分析泄漏一个 280s 定时器
    let innerTimer = null;
    const innerTimeout = new Promise((_, reject) => {
      innerTimer = setTimeout(
        () => reject(new Error('深度分析超时（外部数据接口响应过慢，请稍后重试）')),
        innerTimeoutMs);
    });
    let result;
    try {
      result = await Promise.race([
        deepAnalysis(symbol, name || quote.name, quote, history),
        innerTimeout,
      ]);
    } finally {
      if (innerTimer) clearTimeout(innerTimer);
    }
    result.cachedAt = Date.now();
    result.fromCache = false;
    return result;
  }

  // B2-1：终态惰性过期 + 容量淘汰（只清终态，running 任务绝不误删）
  function evictIfNeeded() {
    if (jobs.size <= maxJobs) return;
    for (const [key, job] of jobs) {
      if (job.status !== 'running') jobs.delete(key);
      if (jobs.size <= maxJobs) break;
    }
  }

  function startJob(symbol, name, forceRefresh) {
    // B2-5：覆盖旧 job 前先作废，旧任务的迟到结果不得污染新任务
    const prev = jobs.get(symbol);
    if (prev) prev.superseded = true;

    const job = {
      status: 'running', startedAt: Date.now(), finishedAt: null,
      result: null, error: null, forceRefresh,
      superseded: false, errorDelivered: false, cacheWritten: false,
    };
    jobs.set(symbol, job);
    evictIfNeeded();

    let settled = false;
    const outerTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      job.status = 'error';
      job.error = '深度分析超时（外部数据接口响应过慢，请稍后重试或点刷新）';
      job.finishedAt = Date.now();
      logger.log(`[DeepJob] ${symbol} 外层安全网超时，底层任务仍在运行；迟到结果将只落盘、不回滚状态`);
    }, timeoutMs);

    runOnce(symbol, name).then((result) => {
      const late = settled; // true = 已被外层超时兜底接管
      if (!late) {
        settled = true; clearTimeout(outerTimer);
        if (result && result.__notFound) {
          job.status = 'error'; job.error = '无法获取股票行情数据';
        } else {
          job.result = result; job.status = 'done';
        }
        job.finishedAt = Date.now();
      }

      // B2-2 + B2-5：算完了就别浪费；但已作废的旧 job 结果一律不落盘
      if (result && !result.__notFound && !job.superseded) {
        try {
          writeAnalysisCache(symbol, result); // B2-6：落盘异常隔离，不影响任务状态
          job.cacheWritten = true;
          if (late) logger.log(`[DeepJob] ${symbol} 超时后迟到结果已落盘（job 保持 error，不回滚状态）`);
        } catch (e) {
          logger.error(`[DeepJob] ${symbol} 结果落盘失败：${(e && e.message) || e}`);
        }
      } else if (late && job.superseded) {
        logger.log(`[DeepJob] ${symbol} 迟到结果来自已作废任务，已丢弃（避免覆盖新结果）`);
      }
    }).catch((e) => {
      if (settled) {
        logger.log(`[DeepJob] ${symbol} 已终态后底层报错，忽略：${(e && e.message) || e}`);
        return;
      }
      settled = true; clearTimeout(outerTimer);
      job.status = 'error'; job.error = (e && e.message) || String(e);
      job.finishedAt = Date.now();
    });
    return job;
  }

  // 取/启后台任务：running 一律复用（并发去重）；终态按 TTL / 错误投递状态决定是否重建
  function getOrStartJob(symbol, name, forceRefresh) {
    const existing = jobs.get(symbol);
    if (existing && existing.status === 'running') return existing;

    if (existing && existing.finishedAt != null
        && Date.now() - existing.finishedAt >= doneTtlMs) {
      // B2-1：终态过期，惰性清理；旧 job 作废，迟到结果不再落盘
      existing.superseded = true;
      jobs.delete(symbol);
    }

    const cur = jobs.get(symbol);
    if (cur) {
      if (cur.status === 'error') {
        if (!cur.errorDelivered) return cur; // 错误尚未告知客户端，先让它拿到 500
        // B2-4：已投递过的错误不再永久占用，重新计算
      } else if (cur.status === 'done' && cur.forceRefresh === forceRefresh) {
        return cur; // TTL 内且语义一致 → 复用内存结果（轮询去重）
      }
    }
    return startJob(symbol, name, forceRefresh);
  }

  async function handler(req, res) {
    try {
      const symbol = req.params.symbol;
      const name = (req.query && req.query.name) || '';
      const forceRefresh = !!(req.query && (req.query.refresh === '1' || req.query.refresh === 'true'));

      let stockCode = symbol;
      try {
        const info = detectMarket(symbol);
        stockCode = info.tencentCode.replace(/^(sh|sz)/, '');
      } catch (e) { /* 保底使用原始 symbol */ }

      logger.log(`[DeepAnalysis] Request for ${symbol} (refresh=${forceRefresh})...`);

      // 1) 命中磁盘缓存且非强制刷新 → 立即返回（秒回，不进后台）
      if (!forceRefresh) {
        const cached = readAnalysisCache(symbol);
        if (cached) {
          try { healthMetrics.recordCacheHit('deep-analysis'); } catch (e) { /* 指标失败不影响响应 */ } // [② 健康指标]
          logger.log(`[DeepAnalysis] Serving cached result for ${symbol}`);
          cached.localDocuments = getLocalDocuments(stockCode);
          attachDeepAICache(symbol, cached);
          return res.json({ ...cached, fromCache: true });
        }
      }

      // [② 健康指标] 未命中缓存：finish 钩子按结果记 miss（200，含 running 轮询，口径如实）/error（>=400）；aborted 不触发 finish 由 requestLogger 归类
      res.once('finish', () => {
        try {
          if (res.statusCode < 400) healthMetrics.recordCacheMiss('deep-analysis'); // 200-399 记 miss（含 running 轮询，口径如实）；>=400 由 requestLogger 单点记 error（防双计）
        } catch (e) { /* 指标失败不影响响应 */ }
      });
      // 2) 启动/复用后台任务，立即返回状态（绝不阻塞等待）
      const job = getOrStartJob(symbol, name, forceRefresh);
      if (job.status === 'done' && job.result) {
        const out = { ...job.result, fromCache: false, background: true };
        out.localDocuments = getLocalDocuments(stockCode);
        attachDeepAICache(symbol, out);
        return res.json(out);
      }
      if (job.status === 'error') {
        job.errorDelivered = true; // B2-4：错误只投递一次，下次同参数请求即可重试
        return res.status(500).json({ error: job.error || '深度分析失败' });
      }
      return res.json({ status: 'running', startedAt: job.startedAt, finishedAt: null });
    } catch (err) {
      logger.error('Deep analysis route error:', err);
      res.status(500).json({ error: err.message });
    }
  }

  return { jobs, handler, getOrStartJob, startJob, runOnce };
}

module.exports = { createDeepJobManager };
