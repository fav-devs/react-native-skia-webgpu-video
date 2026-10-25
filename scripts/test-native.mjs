import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Local native tests never download dependencies or change system settings.
// On macOS the media tests access real CoreVideo/AVFoundation services; run
// outside a sandbox which blocks IOSurface or VideoToolbox to exercise them.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = mkdtempSync(join(tmpdir(), 'rnskv-native-tests-'));
const compiler = process.env.CXX || 'clang++';
const asan = process.argv.includes('--asan');
const pureOnly = process.argv.includes('--pure-only');
const flags = ['-std=c++20', '-g', ...(asan ? ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'] : [])];
const includes = ['-I', 'cpp', '-I', 'ios',
  '-I', 'node_modules/react-native/ReactCommon/jsi',
  '-I', 'node_modules/react-native/ReactCommon/callinvoker'];
const jsi = 'node_modules/react-native/ReactCommon/jsi/jsi/jsi.cpp';
const monitor = 'cpp/RNSVRuntimeLifecycleMonitor.cpp';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status ?? result.signal}`);
}

function test(name, sources, extra = []) {
  const executable = join(output, name);
  run(compiler, [...flags, ...includes, ...sources, ...extra, '-o', executable]);
  run(executable, []);
}

try {
  run(process.execPath, ['scripts/test-skia-provider-ownership.mjs', ...(asan ? ['--asan'] : [])]);
  test('seek-policy', ['test/native/SeekPolicyTest.cpp']);
  test('decoder-window', ['test/native/DecoderWindowTest.cpp']);
  test('item-time', ['test/native/ItemTimeTest.cpp']);
  test('shuttle', ['test/native/ShuttleTest.cpp']);
  test('memory-budget', ['test/native/MemoryBudgetTest.cpp']);
  test('rgba-frame-lease', ['android/tests/RgbaFrameLeaseTest.cpp']);
  test('checked-sizes', ['test/native/CheckedSizesTest.cpp']);
  run(compiler, [...flags, ...includes, '-fsyntax-only',
    'cpp/RNSVEventEmitter.cpp', 'cpp/RNSVHostObject.cpp', monitor,
    'cpp/RNSVMemoryBudget.cpp']);
  if (process.platform === 'darwin' && !pureOnly) {
    test('runtime-lifetime', ['test/native/RuntimeLifetimeTest.cpp',
      'cpp/RNSVEventEmitter.cpp', 'cpp/RNSVHostObject.cpp', monitor, jsi,
      'node_modules/react-native/ReactCommon/jsc/JSCRuntime.cpp'],
    ['-I', 'node_modules/react-native/ReactCommon/jsc', '-framework', 'JavaScriptCore']);
    const mediaFlags = ['-fobjc-arc', '-DRNSV_NATIVE_TESTS',
      '-Wno-deprecated-declarations', '-framework', 'Foundation',
      '-framework', 'CoreVideo', '-framework', 'CoreMedia',
      '-framework', 'AVFoundation', '-framework', 'VideoToolbox'];
    const common = ['ios/VideoFrame.mm', 'cpp/RNSVMemoryBudget.cpp', monitor, jsi];
    test('buffer-ownership', ['ios/tests/BufferOwnershipTest.mm', ...common], mediaFlags);
    test('reference-encoder', ['ios/tests/EncoderReferenceTest.mm',
      'ios/VideoEncoderHostObject.mm', 'ios/VideoCompositionItemDecoder.mm',
      'ios/AudioCompositionUtils.mm', 'cpp/RNSVHostObject.cpp', ...common], mediaFlags);
    test('native-validation', ['ios/tests/NativeValidationTest.mm',
      'ios/VideoEncoderHostObject.mm', 'ios/VideoCompositionFramesExtractorSyncHostObject.mm',
      'ios/VideoCompositionItemDecoder.mm', 'ios/AudioCompositionUtils.mm',
      'cpp/RNSVHostObject.cpp', ...common,
      'node_modules/react-native/ReactCommon/jsc/JSCRuntime.cpp'],
    [...mediaFlags, '-I', 'node_modules/react-native/ReactCommon/jsc', '-framework', 'JavaScriptCore']);
    run(process.execPath, ['scripts/test-ios-parity-syntax.mjs']);
    run(process.execPath, ['scripts/test-skia-patch-syntax.mjs']);
  } else {
    console.log(JSON.stringify({ nativeMediaTests: 'skipped',
      reason: pureOnly ? '--pure-only requested' : 'CoreVideo/AVFoundation require macOS' }));
  }
  console.log(JSON.stringify({ nativeTests: 'passed', sanitizers: asan }));
} finally {
  rmSync(output, { recursive: true, force: true });
}
