import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

export type HeadDirection = 'up' | 'down' | 'left' | 'right';

export interface HeadDirectionEvent {
  direction: HeadDirection;
  confidence: number;
  timestamp: number;
}

export interface HeadMotionSnapshot {
  tracking: boolean;
  calibrated: boolean;
  fps: number;
  debug: string;
  lastDirection?: HeadDirection;
}

interface HeadMotionControllerOptions {
  poseModelPath?: string;
  wasmPath?: string;
  mirrorHorizontal?: boolean;
  sensitivityScale?: number;
}

interface FaceBaseline {
  noseOffsetX: number;
  noseOffsetY: number;
  shoulderWidth: number;
}

const POSE_MODEL_CDN =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm';

const uniqueNonEmpty = (values: Array<string | undefined>): string[] => {
  const set = new Set<string>();
  values.forEach((value) => {
    if (value && value.trim().length > 0) {
      set.add(value);
    }
  });
  return [...set];
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const average = (values: number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'unknown error';
};

export class HeadMotionController {
  private readonly options: Required<HeadMotionControllerOptions>;
  private readonly listeners = new Set<(event: HeadDirectionEvent) => void>();

  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private rafId: number | null = null;

  private running = false;
  private baseline: FaceBaseline | null = null;

  private frameCount = 0;
  private fpsTickStart = 0;
  private fps = 0;

  private lastEmittedDirection: HeadDirection | null = null;
  private lastEmitAt = 0;
  private candidateDirection: HeadDirection | null = null;
  private candidateFrameCount = 0;
  private candidateConfidence = 0;
  private smoothedDx = 0;
  private smoothedDy = 0;

  private snapshot: HeadMotionSnapshot = {
    tracking: false,
    calibrated: false,
    fps: 0,
    debug: 'Idle'
  };

  constructor(options: HeadMotionControllerOptions = {}) {
    this.options = {
      poseModelPath: options.poseModelPath ?? '/models/pose_landmarker_lite.task',
      wasmPath: options.wasmPath ?? '/models/wasm',
      mirrorHorizontal: options.mirrorHorizontal ?? true,
      sensitivityScale: options.sensitivityScale ?? 1
    };
  }

  onDirection(listener: (event: HeadDirectionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): HeadMotionSnapshot {
    return { ...this.snapshot };
  }

  setMirrorHorizontal(enabled: boolean): void {
    this.options.mirrorHorizontal = enabled;
  }

  async start(videoEl: HTMLVideoElement, cameraId?: string): Promise<void> {
    if (this.running) {
      return;
    }

    if (!window.isSecureContext) {
      throw new Error('Camera requires HTTPS or localhost secure context.');
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Current browser does not support getUserMedia.');
    }

    this.video = videoEl;
    this.video.autoplay = true;
    this.video.muted = true;
    this.video.playsInline = true;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 30 },
          deviceId: cameraId ? { exact: cameraId } : undefined
        },
        audio: false
      });
    } catch (error) {
      throw new Error(`Cannot open camera: ${formatUnknownError(error)}`);
    }

    this.video.srcObject = this.stream;
    await this.video.play();

    try {
      await this.initPoseLandmarker();
    } catch (error) {
      if (this.stream) {
        this.stream.getTracks().forEach((track) => track.stop());
        this.stream = null;
      }
      this.video.pause();
      this.video.srcObject = null;
      throw error;
    }

    this.running = true;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsTickStart = performance.now();
    this.snapshot = {
      tracking: false,
      calibrated: false,
      fps: 0,
      debug: 'Camera started'
    };

    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
    }

    this.poseLandmarker?.close();
    this.poseLandmarker = null;
    this.baseline = null;
    this.lastEmittedDirection = null;
    this.lastEmitAt = 0;
    this.candidateDirection = null;
    this.candidateFrameCount = 0;
    this.candidateConfidence = 0;
    this.smoothedDx = 0;
    this.smoothedDy = 0;

    this.snapshot = {
      tracking: false,
      calibrated: false,
      fps: 0,
      debug: 'Stopped'
    };
  }

  async calibrate(): Promise<void> {
    if (!this.running || !this.video || !this.poseLandmarker) {
      throw new Error('Camera not started yet.');
    }

    const samples: FaceBaseline[] = [];
    const startedAt = performance.now();
    while (samples.length < 12 && performance.now() - startedAt < 1800) {
      const sample = this.captureBaselineSample();
      if (sample) {
        samples.push(sample);
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    if (samples.length < 6) {
      throw new Error('Calibration needs nose + shoulders visible and stable.');
    }

    this.baseline = {
      noseOffsetX: average(samples.map((sample) => sample.noseOffsetX)),
      noseOffsetY: average(samples.map((sample) => sample.noseOffsetY)),
      shoulderWidth: average(samples.map((sample) => sample.shoulderWidth))
    };
    this.lastEmittedDirection = null;
    this.lastEmitAt = 0;
    this.candidateDirection = null;
    this.candidateFrameCount = 0;
    this.candidateConfidence = 0;
    this.smoothedDx = 0;
    this.smoothedDy = 0;

    this.snapshot.calibrated = true;
    this.snapshot.debug = 'Calibrated';
  }

  private captureBaselineSample(): FaceBaseline | null {
    if (!this.video || !this.poseLandmarker) {
      return null;
    }

    const result = this.poseLandmarker.detectForVideo(this.video, performance.now());
    const landmarks = result.landmarks?.[0];
    if (!landmarks) {
      return null;
    }

    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    if (!nose || !leftShoulder || !rightShoulder) {
      return null;
    }

    const shoulderWidth = Math.hypot(
      leftShoulder.x - rightShoulder.x,
      leftShoulder.y - rightShoulder.y
    );
    if (shoulderWidth < 1e-4) {
      return null;
    }

    const shoulderCenterX = (leftShoulder.x + rightShoulder.x) / 2;
    const shoulderCenterY = (leftShoulder.y + rightShoulder.y) / 2;

    return {
      noseOffsetX: nose.x - shoulderCenterX,
      noseOffsetY: nose.y - shoulderCenterY,
      shoulderWidth
    };
  }

  private loop(): void {
    if (!this.running || !this.video || !this.poseLandmarker) {
      return;
    }

    const now = performance.now();
    const result = this.poseLandmarker.detectForVideo(this.video, now);
    const landmarks = result.landmarks?.[0];

    this.frameCount += 1;
    if (now - this.fpsTickStart >= 1000) {
      this.fps = Math.round((this.frameCount * 1000) / (now - this.fpsTickStart));
      this.frameCount = 0;
      this.fpsTickStart = now;
    }

    if (!landmarks) {
      this.lastEmittedDirection = null;
      this.lastEmitAt = 0;
      this.candidateDirection = null;
      this.candidateFrameCount = 0;
      this.candidateConfidence = 0;
      this.smoothedDx = 0;
      this.smoothedDy = 0;
      this.snapshot = {
        ...this.snapshot,
        tracking: false,
        fps: this.fps,
        debug: 'Tracking lost'
      };
      this.rafId = requestAnimationFrame(() => this.loop());
      return;
    }

    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    if (!nose || !leftShoulder || !rightShoulder) {
      this.lastEmittedDirection = null;
      this.lastEmitAt = 0;
      this.candidateDirection = null;
      this.candidateFrameCount = 0;
      this.candidateConfidence = 0;
      this.smoothedDx = 0;
      this.smoothedDy = 0;
      this.snapshot = {
        ...this.snapshot,
        tracking: false,
        fps: this.fps,
        debug: 'Need nose + shoulders in frame'
      };
      this.rafId = requestAnimationFrame(() => this.loop());
      return;
    }

    const shoulderWidth = Math.hypot(
      leftShoulder.x - rightShoulder.x,
      leftShoulder.y - rightShoulder.y
    );

    this.snapshot = {
      ...this.snapshot,
      tracking: true,
      fps: this.fps,
      debug: this.baseline ? 'Tracking' : 'Ready to calibrate'
    };

    const baseline = this.baseline;
    if (!baseline || shoulderWidth < 1e-4) {
      this.rafId = requestAnimationFrame(() => this.loop());
      return;
    }

    const shoulderCenterX = (leftShoulder.x + rightShoulder.x) / 2;
    const shoulderCenterY = (leftShoulder.y + rightShoulder.y) / 2;

    let dx = nose.x - shoulderCenterX - baseline.noseOffsetX;
    const dy = nose.y - shoulderCenterY - baseline.noseOffsetY;

    if (this.options.mirrorHorizontal) {
      dx = -dx;
    }

    const normalizedShoulderWidth = (shoulderWidth + baseline.shoulderWidth) / 2;
    const threshold = (0.09 / Math.max(this.options.sensitivityScale, 0.4)) * normalizedShoulderWidth;

    // Low-latency smoothing to reduce single-frame jitter.
    const smoothing = 0.45;
    this.smoothedDx = this.smoothedDx * (1 - smoothing) + dx * smoothing;
    this.smoothedDy = this.smoothedDy * (1 - smoothing) + dy * smoothing;

    const isNearNeutral =
      Math.abs(this.smoothedDx) < threshold * 0.65 && Math.abs(this.smoothedDy) < threshold * 0.75;
    if (isNearNeutral) {
      const driftBlend = 0.035;
      baseline.noseOffsetX =
        baseline.noseOffsetX * (1 - driftBlend) + (nose.x - shoulderCenterX) * driftBlend;
      baseline.noseOffsetY =
        baseline.noseOffsetY * (1 - driftBlend) + (nose.y - shoulderCenterY) * driftBlend;
      baseline.shoulderWidth = baseline.shoulderWidth * (1 - driftBlend) + shoulderWidth * driftBlend;
    }

    const signal = this.resolveDirection(this.smoothedDx, this.smoothedDy, threshold);
    if (!signal) {
      this.candidateDirection = null;
      this.candidateFrameCount = 0;
      this.candidateConfidence = 0;
      this.snapshot.debug = 'Micro movement ignored';
      this.rafId = requestAnimationFrame(() => this.loop());
      return;
    }

    if (this.candidateDirection !== signal.direction) {
      this.candidateDirection = signal.direction;
      this.candidateFrameCount = 1;
      this.candidateConfidence = signal.confidence;
      this.rafId = requestAnimationFrame(() => this.loop());
      return;
    }

    this.candidateFrameCount += 1;
    this.candidateConfidence = Math.max(this.candidateConfidence, signal.confidence);

    const requiredFrames = this.candidateConfidence >= 0.72 ? 1 : 2;
    const minGapMs = signal.direction === this.lastEmittedDirection ? 220 : 90;

    if (this.candidateFrameCount >= requiredFrames && now - this.lastEmitAt >= minGapMs) {
      if (signal.direction === this.lastEmittedDirection) {
        this.rafId = requestAnimationFrame(() => this.loop());
        return;
      }

      const event: HeadDirectionEvent = {
        direction: signal.direction,
        confidence: this.candidateConfidence,
        timestamp: now
      };

      this.listeners.forEach((listener) => listener(event));
      this.snapshot.lastDirection = signal.direction;
      this.lastEmittedDirection = signal.direction;
      this.lastEmitAt = now;
      this.candidateDirection = null;
      this.candidateFrameCount = 0;
      this.candidateConfidence = 0;
      this.snapshot.debug = `Direction: ${signal.direction}`;
    }

    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private resolveDirection(
    dx: number,
    dy: number,
    threshold: number
  ): { direction: HeadDirection; confidence: number } | null {
    const horizontalThreshold = threshold * 0.95;
    const downThreshold = threshold * 1.05;
    const upThreshold = threshold * 1.35;
    const dominanceRatio = 1.12;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (absX >= absY * dominanceRatio && absX > horizontalThreshold) {
      return {
        direction: dx > 0 ? 'right' : 'left',
        confidence: clamp01(absX / (horizontalThreshold * 2.1))
      };
    }

    if (absY >= absX * dominanceRatio) {
      if (dy > downThreshold) {
        return {
          direction: 'down',
          confidence: clamp01(dy / (downThreshold * 2.1))
        };
      }
      if (dy < -upThreshold) {
        return {
          direction: 'up',
          confidence: clamp01(-dy / (upThreshold * 2.1))
        };
      }
    }

    return null;
  }

  private async initPoseLandmarker(): Promise<void> {
    const wasmCandidates = uniqueNonEmpty([this.options.wasmPath, WASM_CDN]);
    const modelCandidates = uniqueNonEmpty([this.options.poseModelPath, POSE_MODEL_CDN]);

    let lastError: unknown = null;

    for (const wasmBase of wasmCandidates) {
      try {
        const vision = await FilesetResolver.forVisionTasks(wasmBase);
        for (const modelPath of modelCandidates) {
          try {
            this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
              baseOptions: {
                modelAssetPath: modelPath
              },
              runningMode: 'VIDEO',
              numPoses: 1
            });
            return;
          } catch (error) {
            lastError = error;
          }
        }
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Failed to initialize pose model: ${formatUnknownError(lastError)}`);
  }
}
