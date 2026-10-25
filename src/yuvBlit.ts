/// <reference types="@webgpu/types" />
import type {
  GPUNativeBufferExternalTexture,
  NativeVideoFrame,
} from "react-native-webgpu";
import {
  createNativeVideoGpuFrame,
  videoShaderStages,
  videoUniformBufferUsage,
} from "./gpuDevice";

/** One Android decoder buffer, imported once as an external texture. An
 * ImageReader cycles through a few buffers: each one is imported the first
 * time it shows up, then only its access is opened and closed per frame. */
export type YuvImport = {
  handle: bigint;
  rotation: number;
  /** The import's own reference on the buffer, released with it. */
  source: NativeVideoFrame;
  wrapper: GPUNativeBufferExternalTexture;
  uniforms: GPUBuffer;
  bindGroup: GPUBindGroup;
  /** uv scale and offset last written to `uniforms`. */
  mapping: number[];
};

type YuvBlit = {
  /** The device these were made on: once React Native Skia replaced it
   * (see getVideoGpuDevice), the next blit makes them again. */
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
  sampler: GPUSampler;
  module: GPUShaderModule;
  pipelines: Map<GPUTextureFormat, GPURenderPipeline>;
  /** The whole frame, as is: the uniforms of blitNv12Frame, written once. */
  wholeFrame?: GPUBuffer;
};

// An ImageReader holds four buffers (GLFrameExtractor.READER_IMAGES); the
// slack covers a reader replaced while the clip keeps its producer id.
const maxImportsPerProducer = 6;

// The copyExternalImageToTexture blit of RN WebGPU (VideoFrameBlit.h), opaque
// and without its sRGB destination variant: uv = position01 * scale + offset,
// in the upright frame.
const shader = `
struct Uniforms { uvScale: vec2f, uvOffset: vec2f };
@group(0) @binding(0) var frame: texture_external;
@group(0) @binding(1) var frameSampler: sampler;
@group(0) @binding(2) var<uniform> u: Uniforms;
struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) index: u32) -> VsOut {
  var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let corner = corners[index];
  var out: VsOut;
  out.position = vec4f(corner, 0.0, 1.0);
  let position01 = vec2f(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  out.uv = position01 * u.uvScale + u.uvOffset;
  return out;
}
@fragment fn fs(in: VsOut) -> @location(0) vec4f {
  let sampled = textureSampleBaseClampToEdge(frame, frameSampler, in.uv);
  return vec4f(clamp(sampled.rgb, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

// The samples' encoding is kept as is, as the EGL path and iOS decoding do:
// only the YCbCr matrix and range apply (the driver's suggestion for the
// buffer). Without this, Dawn also converts the video's transfer function and
// primaries to sRGB, and every export brightens the midtones again.
const sourceColorSpace = { primaries: "srgb", transfer: "srgb" } as const;

/** A decoder buffer's crop rectangle once the buffer is turned clockwise for
 * display: the blit samples that upright region, and draws it at the size of
 * its target, which a capped or explicit frame size makes smaller. Throws
 * unless the rectangle lies in the buffer. */
export const yuvFrameRegion = (
  region: { x: number; y: number; width: number; height: number },
  rotation: number,
  buffer: { width: number; height: number },
): { x: number; y: number; width: number; height: number } => {
  "worklet";
  const turned = rotation === 90 || rotation === 270;
  if (
    (rotation !== 0 && !turned && rotation !== 180) ||
    region.x < 0 ||
    region.y < 0 ||
    region.width <= 0 ||
    region.height <= 0 ||
    region.x + region.width > buffer.width ||
    region.y + region.height > buffer.height
  ) {
    throw new Error("Native video buffer region or YUV layout mismatch");
  }
  const width = turned ? region.height : region.width;
  const height = turned ? region.width : region.height;
  if (rotation === 90)
    return {
      x: buffer.height - region.y - region.height,
      y: region.x,
      width,
      height,
    };
  if (rotation === 180)
    return {
      x: buffer.width - region.x - region.width,
      y: buffer.height - region.y - region.height,
      width,
      height,
    };
  if (rotation === 270)
    return {
      x: region.y,
      y: buffer.width - region.x - region.width,
      width,
      height,
    };
  return { x: region.x, y: region.y, width, height };
};

const getYuvBlit = (device: GPUDevice): YuvBlit => {
  "worklet";
  const runtime = globalThis as typeof globalThis & {
    __rnskwgpuYuvBlit?: YuvBlit;
  };
  if (runtime.__rnskwgpuYuvBlit?.device !== device) {
    // Made on a lost device, which runs nothing: it goes with that device.
    const layout = device.createBindGroupLayout({
      label: "video YUV blit",
      entries: [
        {
          binding: 0,
          visibility: videoShaderStages.fragment,
          externalTexture: {},
        },
        {
          binding: 1,
          visibility: videoShaderStages.fragment,
          sampler: { type: "filtering" },
        },
        {
          binding: 2,
          visibility: videoShaderStages.vertex,
          buffer: { type: "uniform" },
        },
      ],
    });
    runtime.__rnskwgpuYuvBlit = {
      device,
      layout,
      pipelineLayout: device.createPipelineLayout({
        label: "video YUV blit",
        bindGroupLayouts: [layout],
      }),
      sampler: device.createSampler({
        label: "video YUV blit",
        magFilter: "linear",
        minFilter: "linear",
      }),
      module: device.createShaderModule({
        label: "video YUV blit",
        code: shader,
      }),
      pipelines: new Map(),
    };
  }
  return runtime.__rnskwgpuYuvBlit;
};

const getPipeline = (
  device: GPUDevice,
  blit: YuvBlit,
  format: GPUTextureFormat,
): GPURenderPipeline => {
  "worklet";
  let pipeline = blit.pipelines.get(format);
  if (!pipeline) {
    pipeline = device.createRenderPipeline({
      label: "video YUV blit",
      layout: blit.pipelineLayout,
      vertex: { module: blit.module, entryPoint: "vs" },
      fragment: {
        module: blit.module,
        entryPoint: "fs",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });
    blit.pipelines.set(format, pipeline);
  }
  return pipeline;
};

/** Call only once the GPU work sampling the buffer has completed. */
export const releaseYuvImport = (entry: YuvImport): void => {
  "worklet";
  entry.wrapper.destroy();
  entry.uniforms.destroy();
  entry.source.release();
};

/** Releases a producer's imports, or every producer's. Call only once the GPU
 * work sampling them has completed (a checked flush). */
export const releaseYuvImports = (
  imports: Map<number, YuvImport[]>,
  producer?: number,
): void => {
  "worklet";
  for (const [key, entries] of imports) {
    if (producer !== undefined && key !== producer) continue;
    while (entries.length) {
      releaseYuvImport(entries[0]!);
      entries.shift();
    }
    imports.delete(key);
  }
};

const importYuvBuffer = (
  device: GPUDevice,
  blit: YuvBlit,
  handle: bigint,
  rotation: number,
): YuvImport => {
  "worklet";
  // A reference of its own: the caller's frame keeps its usual lifetime.
  const source = createNativeVideoGpuFrame(handle);
  let wrapper: GPUNativeBufferExternalTexture | null = null;
  let uniforms: GPUBuffer | null = null;
  try {
    wrapper = device.createNativeBufferExternalTexture(source, {
      label: "video decoder buffer",
      rotation: rotation as 0 | 90 | 180 | 270,
      mirrored: false,
      sourceColorSpace,
    });
    uniforms = device.createBuffer({
      label: "video YUV blit uniforms",
      size: 16,
      usage: videoUniformBufferUsage,
    });
    const bindGroup = device.createBindGroup({
      label: "video YUV blit",
      layout: blit.layout,
      entries: [
        { binding: 0, resource: wrapper.externalTexture },
        { binding: 1, resource: blit.sampler },
        { binding: 2, resource: { buffer: uniforms } },
      ],
    });
    return {
      handle,
      rotation,
      source,
      wrapper,
      uniforms,
      bindGroup,
      mapping: [],
    };
  } catch (error) {
    // Nothing was submitted with this import yet.
    uniforms?.destroy();
    wrapper?.destroy();
    source.release();
    throw error;
  }
};

/**
 * Draws the upright `region` of a decoder buffer (see yuvFrameRegion) into
 * the whole of `target`, converting YUV to RGB and scaling it to the target's
 * size; the buffer is imported on its first frame. Submits the draw: the
 * caller waits for it before releasing the frame's lease or `source`, as
 * after copyExternalImageToTexture.
 */
export const blitYuvFrame = (
  device: GPUDevice,
  imports: Map<number, YuvImport[]>,
  producer: number,
  source: NativeVideoFrame,
  rotation: number,
  region: { x: number; y: number; width: number; height: number },
  target: GPUTexture,
): void => {
  "worklet";
  const blit = getYuvBlit(device);
  const pipeline = getPipeline(device, blit, target.format);
  let entries = imports.get(producer);
  if (!entries) {
    entries = [];
    imports.set(producer, entries);
  }
  let index = entries.findIndex(
    (entry) => entry.handle === source.handle && entry.rotation === rotation,
  );
  if (index < 0) {
    // The least recently drawn buffer goes first. Its last frame completed:
    // every import ends with a checked flush before the next one starts.
    if (entries.length >= maxImportsPerProducer) {
      releaseYuvImport(entries[0]!);
      entries.shift();
    }
    entries.push(importYuvBuffer(device, blit, source.handle, rotation));
    index = entries.length - 1;
  } else if (index !== entries.length - 1) {
    entries.push(entries.splice(index, 1)[0]!);
    index = entries.length - 1;
  }
  const entry = entries[index]!;
  // Dawn swaps the apparent size of a frame turned by 90 or 270 degrees.
  const turned = rotation === 90 || rotation === 270;
  const frameWidth = turned ? source.height : source.width;
  const frameHeight = turned ? source.width : source.height;
  const mapping = [
    region.width / frameWidth,
    region.height / frameHeight,
    region.x / frameWidth,
    region.y / frameHeight,
  ];
  if (mapping.some((value, i) => value !== entry.mapping[i])) {
    device.queue.writeBuffer(entry.uniforms, 0, new Float32Array(mapping));
    entry.mapping = mapping;
  }
  entry.wrapper.beginAccess();
  try {
    const encoder = device.createCommandEncoder({ label: "video YUV blit" });
    const pass = encoder.beginRenderPass({
      label: "video YUV blit",
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, entry.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  } finally {
    // The caller's checked flush covers the draw; the release fence is not
    // needed to hand the buffer back.
    entry.wrapper.endAccess()?.fence.destroy();
  }
};

/**
 * iOS: draws a whole NV12 decoder buffer into `target`, converting YUV to RGB
 * with the buffer's YCbCr matrix and range, in its decoded orientation (the
 * frame's rotation applies when it is drawn, as for BGRA frames). Submits the
 * draw. AVAssetReader hands out buffers from a pool rather than a fixed few,
 * so each frame is imported for this draw alone, unlike Android's: the import
 * ends right after the submit (Dawn keeps the surface for the in-flight
 * draw), while the caller holds the frame's lease until the draw completed.
 */
export const blitNv12Frame = (
  device: GPUDevice,
  source: NativeVideoFrame,
  target: GPUTexture,
): void => {
  "worklet";
  const blit = getYuvBlit(device);
  const pipeline = getPipeline(device, blit, target.format);
  if (!blit.wholeFrame) {
    blit.wholeFrame = device.createBuffer({
      label: "video NV12 blit uniforms",
      size: 16,
      usage: videoUniformBufferUsage,
    });
    device.queue.writeBuffer(
      blit.wholeFrame,
      0,
      new Float32Array([1, 1, 0, 0]),
    );
  }
  const external = device.importExternalTexture({
    label: "video decoder buffer",
    source,
    sourceColorSpace,
  });
  try {
    const encoder = device.createCommandEncoder({ label: "video NV12 blit" });
    const pass = encoder.beginRenderPass({
      label: "video NV12 blit",
      colorAttachments: [
        {
          view: target.createView(),
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store",
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        label: "video NV12 blit",
        layout: blit.layout,
        entries: [
          { binding: 0, resource: external },
          { binding: 1, resource: blit.sampler },
          { binding: 2, resource: { buffer: blit.wholeFrame } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  } finally {
    (external as GPUExternalTexture & { destroy?: () => void }).destroy?.();
  }
};
