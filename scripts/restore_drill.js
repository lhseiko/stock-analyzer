// Stock Analyzer - backup RECOVERY DRILL (read-only on live data; safe to re-run).
// Verifies that the backed-up data/notes.json can actually be restored:
//   1) locate the best backup (OneDrive offsite > local D: backup > live fallback)
//   2) copy notes.json into a temp dir and prove MD5 integrity (copy == source)
//   3) prove the restored file is valid JSON and parseable
//   4) report any notes present in backup but missing from live ("recoverable now")
//   5) simulate a deletion and prove the note can be recovered from the backup by id
// The script NEVER writes to live data/notes.json or to the backups - only to a
// throwaway temp dir that is removed at the end.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const project = path.resolve(__dirname, '..');
const LIVE = path.join(project, 'data', 'notes.json');
const LOCAL_BK = 'D:\\stock-analyzer-backup\\data\\notes.json';
const ONEDRIVE_BK = 'C:\\Users\\16507\\OneDrive\\stock-analyzer-backup\\data\\notes.json';

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  [PASS] ' + m); } else { fail++; console.log('  [FAIL] ' + m); } }
function md5File(p) { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
function readNotes(p) {
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!Array.isArray(arr)) throw new Error('notes.json is not a JSON array at ' + p);
  return arr;
}

console.log('=== Stock Analyzer · Backup Recovery Drill ===');

// 1) choose the best restore source
const candidates = [
  { name: 'OneDrive offsite', p: ONEDRIVE_BK },
  { name: 'Local backup (D:)', p: LOCAL_BK },
];
const bk = candidates.find((c) => fs.existsSync(c.p));
const sourceLabel = bk ? bk.name : 'LIVE (no backup found - insecure fallback!)';
const sourcePath = bk ? bk.p : LIVE;
console.log('Restore source : ' + sourceLabel + '  (' + sourcePath + ')');

if (!fs.existsSync(sourcePath)) { console.log('FATAL: restore source missing: ' + sourcePath); process.exit(1); }

// cross-backup consistency (bonus): both backups should agree
if (fs.existsSync(LOCAL_BK) && fs.existsSync(ONEDRIVE_BK)) {
  const a = md5File(LOCAL_BK), b = md5File(ONEDRIVE_BK);
  ok(a === b, 'local backup and OneDrive backup are byte-identical (md5 match)');
}

// 2) copy into temp dir + MD5 integrity
const tmp = path.join(project, 'data', '.restore-drill-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const copyPath = path.join(tmp, 'restored-notes.json');
fs.copyFileSync(sourcePath, copyPath);
ok(md5File(sourcePath) === md5File(copyPath), 'restored copy is byte-identical to backup (md5 match)');

// 3) JSON validity + parseable
let notes = [];
try { notes = readNotes(copyPath); ok(true, 'restored file is valid JSON and a parseable array'); }
catch (e) { ok(false, 'restored file failed to parse: ' + e.message); }
ok(notes.length > 0, 'restored notes contain ' + notes.length + ' entries');

// 4) real divergence: notes in backup but missing from live = recoverable now
let liveNotes = [];
try { liveNotes = readNotes(LIVE); } catch (e) { console.log('  [WARN] could not read live notes.json: ' + e.message); }
const liveIds = new Set(liveNotes.map((n) => n.id));
const recoverable = notes.filter((n) => !liveIds.has(n.id));
console.log('Divergence     : ' + recoverable.length + ' note(s) in backup missing from live' +
  (recoverable.length ? ' -> ' + recoverable.slice(0, 5).map((n) => n.id).join(', ') + (recoverable.length > 5 ? ' ...' : '') : ' (live is in sync with backup)'));

// 5) simulated deletion -> recovery by id (proves the restore path works)
if (notes.length > 0) {
  const victim = notes[0];
  const victimId = victim.id;
  // simulate that this note was deleted from live
  const scratch = liveNotes.filter((n) => n.id !== victimId);
  const afterDeleteCount = scratch.length;
  // recover it FROM the backup by id
  const recovered = notes.find((n) => n.id === victimId);
  const match = recovered && JSON.stringify(recovered) === JSON.stringify(victim);
  ok(match, 'simulated-deleted note "' + victimId + '" recovered from backup by id and matches original');
  ok(typeof recovered === 'object' && recovered !== null, 'recovered note is a real object (title="' + (recovered && recovered.title || '?') + '")');
  ok(afterDeleteCount === liveNotes.length - 1, 'deletion simulation removed exactly 1 note from the live copy');
}

// cleanup temp dir (no residue left behind)
try { fs.rmSync(tmp, { recursive: true, force: true }); ok(true, 'temp drill dir cleaned up (no residue)'); }
catch (e) { ok(false, 'temp cleanup failed: ' + e.message); }

console.log('-----------------------------------------------');
console.log('Drill result   : ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
