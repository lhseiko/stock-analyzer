/**
 * Python 解释器探测（进程级缓存）
 * ----------------------------------------------------------------------------
 * 供需要调用 scripts/ 下 Python 脚本的模块共用：
 *   - routes/aiRoutes.js（行业指数历史行情）
 *   - server.js（研报下载 / 板块拥挤度回补）
 * 原实现位于 server.js，20260906 路由拆分时迁出为共享 lib，避免双份逻辑漂移。
 */
const cp = require('child_process');

let _pyCacheChecked = false;
let _pyCache = null;
function findPython() {
  if (_pyCacheChecked) return _pyCache; // 已探测（含 null）
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = cp.spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (!r.error) { _pyCache = c; _pyCacheChecked = true; return c; } // 能正常启动即为可用
    } catch (e) {
      // 尝试下一个
    }
  }
  _pyCache = null;
  _pyCacheChecked = true;
  return null;
}

module.exports = { findPython };
