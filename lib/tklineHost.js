/**
 * 腾讯 K 线接口「主机族」降级（20261021g）
 * ==========================================================
 * 背景：`ifzq.gtimg.cn/appstock/app/fqkline/get` 会**整段**返回 HTTP 501（所有代码都一样：
 * sh000001 / sz399001 / sh600519 / sz000902 全是 501），而**同一路径**在
 * `web.ifzq.gtimg.cn` 正常返回 200。写死单主机时，一次对端策略调整就会让
 * 「个股日K / 大盘技术分析 / 市场情绪量价因子 / 准确率结算」同时降级——而且日志里只看到
 * 一条 `Request failed with status code 501`，很容易被当成业务 bug。
 *
 * 设计：只做**同一路径的主机降级**，不参与解析、不改参数——调用方拿到的仍是原响应体。
 * 顺序固定 ifzq → web.ifzq（历史上两个域名的可用性此消彼长，谁在前都会轮到）。
 */
const axios = require('axios');

const KLINE_HOSTS = ['https://ifzq.gtimg.cn', 'https://web.ifzq.gtimg.cn'];

/**
 * @param {string} pathQuery 以 / 开头的路径+查询串，例如 `/appstock/app/fqkline/get?param=...`
 * @param {object} opts      axios 配置（headers / timeout 等，原样透传）
 * @returns {Promise<any>}   axios 的 `resp.data`
 */
async function getKlineJson(pathQuery, opts = {}) {
  let lastErr = null;
  for (const host of KLINE_HOSTS) {
    try {
      const resp = await axios.get(host + pathQuery, opts);
      return resp.data;
    } catch (e) {
      lastErr = e;
      // 只对「整段不可用」级别（5xx / 网络错误）换主机；4xx 是参数问题，换主机也没用
      const st = e && e.response && e.response.status;
      if (st && st < 500) break;
    }
  }
  throw lastErr || new Error('腾讯K线接口不可用');
}

module.exports = { getKlineJson, KLINE_HOSTS };
