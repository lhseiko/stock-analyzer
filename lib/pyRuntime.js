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
// [20261015a] 失败不再永久缓存：受管 Python 是指向 WorkBuddy 应用资源目录的符号链接，
// WorkBuddy 自更新重写该目录的几秒窗口内探测会全部失败；永久缓存失败会让所有 Python
// 依赖模块到重启前都无法自愈。改为失败冷却 60s 后自动重探。
let _pyFailUntil = 0;
const PY_FAIL_COOLDOWN_MS = 60 * 1000;
function findPython() {
  if (_pyCacheChecked) return _pyCache; // 已探测成功（永久缓存）
  if (Date.now() < _pyFailUntil) return null; // 失败冷却期内直接复用失败结论
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
  _pyFailUntil = Date.now() + PY_FAIL_COOLDOWN_MS;
  return null;
}

module.exports = { findPython };
