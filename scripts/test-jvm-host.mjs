import { readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function cachedJar(directory, name) {
  if (!existsSync(directory)) return null;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) { const found = cachedJar(path, name); if (found) return found; }
  }
  return null;
}
const cache = join(homedir(), '.gradle/caches/modules-2/files-2.1');
const junit = process.env.RNSV_JUNIT_JAR ?? cachedJar(join(cache, 'junit/junit'), 'junit-4.13.2.jar');
const hamcrest = process.env.RNSV_HAMCREST_JAR ?? cachedJar(join(cache, 'org.hamcrest/hamcrest-core'), 'hamcrest-core-1.3.jar');
if (!junit || !hamcrest) throw new Error('Local JUnit 4.13.2 and Hamcrest 1.3 jars are required; set RNSV_JUNIT_JAR and RNSV_HAMCREST_JAR. No dependencies are downloaded.');
const output = mkdtempSync(join(tmpdir(), 'rnskv-jvm-host-'));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: capture ? 'utf8' : undefined,
    timeout: 120000,
  });
  if (capture) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
  return result.stdout ?? '';
}
try {
  const path = 'java/com/azzapp/rnskv';
  const classes = ['FrameSize', 'DecoderWindow', 'RgbaLayout', 'DecodeRequests', 'ItemTime'];
  const sources = classes.flatMap(name => [`android/src/main/${path}/${name}.java`, `android/src/test/${path}/${name}Test.java`]);
  run('javac', ['-cp', `${junit}:${hamcrest}`, '-d', output, ...sources]);
  const testOutput = run('java', ['-cp', `${output}:${junit}:${hamcrest}`, 'org.junit.runner.JUnitCore', ...classes.map(name => `com.azzapp.rnskv.${name}Test`)], true);
  const count = testOutput.match(/^OK \((\d+) tests?\)\s*$/m);
  if (!count) throw new Error('JUnit exited successfully without a recognizable test count');
  console.log(JSON.stringify({ jvmHostAssertions: Number(count[1]), legacyAssertions: 12, status: 'passed', deviceExecution: 'not-tested' }));
} finally {
  rmSync(output, { recursive: true, force: true });
}
