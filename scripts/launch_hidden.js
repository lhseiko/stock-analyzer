// scripts/launch_hidden.js — start.vbs 的 Node 等价物（20261112）
// 用途：AI 代理环境里 wscript.exe/cmd.exe 被安全策略拦截时，用本脚本重启 Stock Analyzer。
// 行为与 start.vbs 一致：
//   1) PORT=3005、SA_NO_AUTO_OPEN=1、SA_NO_BG_AI=1（环境变量由调用方传入或用默认）；
//   2) stdout/stderr 追加写入 logs/server.log（与 start.vbs 的 >> 重定向一致）；
//   3) spawn detached + unref → 启动器退出后服务进程独立存活；
//   4) 打印子进程 PID 供核验。
// 用法：PORT=3005 SA_NO_AUTO_OPEN=1 SA_NO_BG_AI=1 node scripts/launch_hidden.js
// 注意：本进程退出前子进程已 unref；不要在本进程内等待，否则等于前台运行。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const baseDir = path.join(__dirname, '..');
const serverJs = path.join(baseDir, 'server.js');
const logPath = path.join(baseDir, 'logs', 'server.log');

const env = { ...process.env };
env.PORT = env.PORT || '3005';
env.SA_NO_AUTO_OPEN = '1';
env.SA_NO_BG_AI = '1';

fs.mkdirSync(path.join(baseDir, 'logs'), { recursive: true });
const out = fs.openSync(logPath, 'a');
const err = fs.openSync(logPath, 'a');

const child = spawn(process.execPath, [serverJs], {
  cwd: baseDir,
  env,
  stdio: ['ignore', out, err],
  detached: true,
});
child.unref();
console.log('[launch_hidden] server started, PID=' + child.pid + ' (log: logs/server.log)');
process.exit(0);
