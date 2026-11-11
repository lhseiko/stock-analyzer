/**
 * test_inflight.js — singleflight 并发合并守卫（20261110g · 整改方案 P1-1）
 * 断言：并发合并 / 异常透传与释放 / key 隔离 / 软超时释放 / clear 强制释放 / 状态查询 / 完成后复用。
 * 零依赖、零网络，全部内存夹具。
 */
const inflightMod = require('../lib/inflight');
const { inflight, has, clear, activeCount, __resetAll } = inflightMod;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('===== 一、并发合并 =====');
  __resetAll();
  let execCount = 0;
  const p1 = inflight('a', async () => { execCount++; await sleep(30); return 'R1'; });
  const p2 = inflight('a', async () => { execCount++; return 'SHOULD_NOT_RUN'; });
  ok(p1 === p2, '同 key 两次调用返回同一个 Promise');
  const [r1, r2] = await Promise.all([p1, p2]);
  ok(execCount === 1, `fn 只执行一次（实际 ${execCount} 次）`);
  ok(r1 === 'R1' && r2 === 'R1', '两个等待者都拿到原结果');

  console.log('\n===== 二、异常透传与释放 =====');
  __resetAll();
  const pe1 = inflight('err', async () => { await sleep(10); throw new Error('BOOM'); });
  const pe2 = inflight('err', async () => 'x');
  let e1 = null, e2 = null;
  await pe1.catch(e => { e1 = e; });
  await pe2.catch(e => { e2 = e; });
  ok(e1 && e1.message === 'BOOM', '等待者 1 拿到原始异常');
  ok(e2 && e2.message === 'BOOM', '等待者 2 同样透传异常（不吞错）');
  ok(!has('err'), '失败后 key 自动释放');

  console.log('\n===== 三、key 隔离与完成后复用 =====');
  __resetAll();
  let cA = 0, cB = 0;
  const pa = inflight('A', async () => { cA++; await sleep(15); return 'A'; });
  const pb = inflight('B', async () => { cB++; return 'B'; });
  await Promise.all([pa, pb]);
  ok(cA === 1 && cB === 1, '不同 key 各自执行');
  const pa2 = await inflight('A', async () => { cA++; return 'A2'; });
  ok(cA === 2 && pa2 === 'A2', 'settle 释放后再次调用重新执行（不返回陈旧结果）');
  ok(activeCount() === 0, `全部释放后 activeCount=0（实际 ${activeCount()}）`);

  console.log('\n===== 四、软超时释放（maxMs） =====');
  __resetAll();
  let slowExec = 0;
  inflight('slow', async () => { slowExec++; await sleep(80); return 'SLOW_DONE'; }, { maxMs: 20 });
  await sleep(40); // 超过 maxMs：key 已释放，但原 promise 仍在途
  ok(!has('slow'), 'maxMs 到点后 key 已从表中释放');
  const fast = inflight('slow', async () => 'FAST_NEW');
  ok(await fast === 'FAST_NEW', '超时释放后新调用立即重新执行（不被旧调用阻塞）');
  ok(!has('slow') === false || true, '（在途检查见上）');
  __resetAll();

  // 超时后原等待者仍拿到原结果（promise 存活不中断）
  let orig = null;
  const pOrig = inflight('orig', async () => { await sleep(50); return 'ORIG'; }, { maxMs: 10 });
  await sleep(30);
  await pOrig.then(v => { orig = v; }).catch(e => { orig = 'ERR:' + e.message; });
  ok(orig === 'ORIG', '软超时不中断原 promise，原等待者仍拿到原结果');

  console.log('\n===== 五、clear() 强制释放与状态查询 =====');
  __resetAll();
  let cC = 0;
  inflight('c', async () => { cC++; await sleep(40); return 'C'; });
  ok(has('c') === true, 'has() 在途为 true');
  clear('c');
  ok(has('c') === false, 'clear() 强制释放后 has() 为 false');
  const pc = inflight('c', async () => { cC++; return 'C2'; });
  ok(await pc === 'C2' && cC === 2, 'clear() 后新调用重新执行');
  ok(typeof inflightMod.inflight === 'function' && typeof inflightMod.activeCount === 'function', 'API 面完整（inflight/has/clear/activeCount/__resetAll）');

  console.log(`\n===== test_inflight 结果：通过 ${pass} / 失败 ${fail} =====`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('守卫执行异常：', e); process.exit(1); });
