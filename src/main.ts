import './styles.css';
import { HeadMotionController, type HeadDirection } from './motion/HeadMotionController';
import { SnakeGame } from './snake/SnakeGame';

const BEST_SCORE_KEY = 'necksnake_best_score';
const DEFAULT_GRID_COLS = 28;
const DEFAULT_GRID_ROWS = 18;
const DEFAULT_SPEED_CELLS_PER_SEC = 7;

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
};

const speedToMs = (cellsPerSec: number): number => {
  const safeSpeed = Math.max(1, cellsPerSec);
  return Math.round(1000 / safeSpeed);
};

const requireElement = <T extends HTMLElement>(selector: string): T => {
  const found = document.querySelector<T>(selector);
  if (!found) {
    throw new Error(`Missing element: ${selector}`);
  }
  return found;
};

const directionLabel = (direction: HeadDirection): string => {
  if (direction === 'up') {
    return '上';
  }
  if (direction === 'down') {
    return '下';
  }
  if (direction === 'left') {
    return '左';
  }
  return '右';
};

const parseBestScore = (): number => {
  const raw = window.localStorage.getItem(BEST_SCORE_KEY);
  if (!raw) {
    return 0;
  }
  const score = Number.parseInt(raw, 10);
  return Number.isFinite(score) && score > 0 ? score : 0;
};

const app = requireElement<HTMLElement>('#app');

app.innerHTML = `
  <main class="page">
    <section class="header">
      <h1>NeckSnake</h1>
      <p>转动头部（上/下/左/右）控制贪吃蛇移动。</p>
    </section>

    <section class="layout">
      <aside class="panel camera-panel">
        <h2>摄像头与校准</h2>
        <video class="camera-video" data-k="camera" autoplay muted playsinline></video>

        <div class="controls">
          <button data-k="open-camera">1. 打开摄像头</button>
          <button data-k="calibrate">2. 校准中立姿态</button>
          <button data-k="start-game">3. 开始/重开</button>
        </div>

        <label class="mirror-toggle">
          <input type="checkbox" data-k="mirror" checked />
          镜像控制
        </label>

        <div class="status-list">
          <p><span>状态</span><strong data-k="status">等待开始</strong></p>
          <p><span>Tracking</span><strong data-k="tracking">-</strong></p>
          <p><span>FPS</span><strong data-k="fps">-</strong></p>
          <p><span>最近方向</span><strong data-k="direction">-</strong></p>
          <p><span>方向置信度</span><strong data-k="confidence">-</strong></p>
        </div>

        <p class="tips">提示：先坐正并保持肩膀入镜，点“校准中立姿态”后再开始游戏。</p>
      </aside>

      <section class="panel game-panel">
        <h2>Snake</h2>
        <div class="game-options">
          <div class="option-grid">
            <label>
              网格列数
              <input type="number" data-k="grid-cols" min="12" max="60" step="1" value="${DEFAULT_GRID_COLS}" />
            </label>
            <label>
              网格行数
              <input type="number" data-k="grid-rows" min="10" max="40" step="1" value="${DEFAULT_GRID_ROWS}" />
            </label>
            <button class="ghost-button" data-k="apply-grid">应用网格</button>
          </div>

          <label class="inline-check">
            <input type="checkbox" data-k="wrap-around" />
            边界穿越（蛇碰到边界时从另一侧出现）
          </label>

          <label class="speed-row">
            速度
            <input type="range" data-k="speed" min="4" max="14" step="1" value="${DEFAULT_SPEED_CELLS_PER_SEC}" />
            <strong data-k="speed-value">${DEFAULT_SPEED_CELLS_PER_SEC}</strong>
            <span>格/秒</span>
          </label>
        </div>

        <canvas data-k="canvas" width="840" height="540"></canvas>
        <div class="score-strip">
          <span>当前分数: <strong data-k="score">0</strong></span>
          <span>历史最佳: <strong data-k="best">0</strong></span>
        </div>
      </section>
    </section>
  </main>
`;

const videoEl = requireElement<HTMLVideoElement>('[data-k="camera"]');
const openCameraButton = requireElement<HTMLButtonElement>('[data-k="open-camera"]');
const calibrateButton = requireElement<HTMLButtonElement>('[data-k="calibrate"]');
const startGameButton = requireElement<HTMLButtonElement>('[data-k="start-game"]');
const mirrorCheckbox = requireElement<HTMLInputElement>('[data-k="mirror"]');

const statusEl = requireElement<HTMLElement>('[data-k="status"]');
const trackingEl = requireElement<HTMLElement>('[data-k="tracking"]');
const fpsEl = requireElement<HTMLElement>('[data-k="fps"]');
const directionEl = requireElement<HTMLElement>('[data-k="direction"]');
const confidenceEl = requireElement<HTMLElement>('[data-k="confidence"]');

const scoreEl = requireElement<HTMLElement>('[data-k="score"]');
const bestEl = requireElement<HTMLElement>('[data-k="best"]');
const gridColsInput = requireElement<HTMLInputElement>('[data-k="grid-cols"]');
const gridRowsInput = requireElement<HTMLInputElement>('[data-k="grid-rows"]');
const applyGridButton = requireElement<HTMLButtonElement>('[data-k="apply-grid"]');
const wrapAroundCheckbox = requireElement<HTMLInputElement>('[data-k="wrap-around"]');
const speedInput = requireElement<HTMLInputElement>('[data-k="speed"]');
const speedValueEl = requireElement<HTMLElement>('[data-k="speed-value"]');

const canvas = requireElement<HTMLCanvasElement>('[data-k="canvas"]');

let bestScore = parseBestScore();
bestEl.textContent = String(bestScore);

const motion = new HeadMotionController({
  mirrorHorizontal: mirrorCheckbox.checked
});

const snake = new SnakeGame(canvas, {
  onScoreChange: (score) => {
    scoreEl.textContent = String(score);
  },
  onGameOver: (finalScore) => {
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestEl.textContent = String(bestScore);
      window.localStorage.setItem(BEST_SCORE_KEY, String(bestScore));
    }

    statusEl.textContent = `游戏结束，得分 ${finalScore}。请重新开始。`;
  }
}, {
  cols: DEFAULT_GRID_COLS,
  rows: DEFAULT_GRID_ROWS,
  wrapAround: false,
  speedMs: speedToMs(DEFAULT_SPEED_CELLS_PER_SEC)
});

window.addEventListener('resize', () => {
  snake.resize();
});

const setStatus = (text: string): void => {
  statusEl.textContent = text;
};

const applyGridSettings = (): void => {
  const cols = clampInt(Number(gridColsInput.value), 12, 60);
  const rows = clampInt(Number(gridRowsInput.value), 10, 40);
  gridColsInput.value = String(cols);
  gridRowsInput.value = String(rows);

  const result = snake.updateOptions({ cols, rows });
  if (result.restarted) {
    setStatus(`网格已更新为 ${cols}x${rows}，当前局已重置并继续。`);
  } else {
    setStatus(`网格已更新为 ${cols}x${rows}。`);
  }
};

let cameraReady = false;
let calibrated = false;

openCameraButton.addEventListener('click', () => {
  void (async () => {
    if (cameraReady) {
      setStatus('摄像头已开启。');
      return;
    }

    openCameraButton.disabled = true;
    setStatus('正在打开摄像头...');

    try {
      await motion.start(videoEl);
      cameraReady = true;
      setStatus('摄像头已开启，请先做校准。');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      setStatus(`开启失败: ${message}`);
      openCameraButton.disabled = false;
    }
  })();
});

calibrateButton.addEventListener('click', () => {
  void (async () => {
    if (!cameraReady) {
      setStatus('请先打开摄像头。');
      return;
    }

    calibrateButton.disabled = true;
    setStatus('校准中，请保持自然中立姿态...');

    try {
      await motion.calibrate();
      calibrated = true;
      setStatus('校准成功，可以开始游戏。');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      setStatus(`校准失败: ${message}`);
    } finally {
      calibrateButton.disabled = false;
    }
  })();
});

startGameButton.addEventListener('click', () => {
  if (!cameraReady) {
    setStatus('请先打开摄像头。');
    return;
  }

  if (!calibrated) {
    setStatus('请先做校准。');
    return;
  }

  snake.start();
  directionEl.textContent = '-';
  confidenceEl.textContent = '-';
  setStatus('游戏进行中：转动头部控制蛇的方向。');
});

applyGridButton.addEventListener('click', () => {
  applyGridSettings();
});

wrapAroundCheckbox.addEventListener('change', (event) => {
  const enabled = (event.target as HTMLInputElement).checked;
  snake.updateOptions({ wrapAround: enabled });
  setStatus(enabled ? '已开启边界穿越。' : '已关闭边界穿越。');
});

speedInput.addEventListener('input', (event) => {
  const cellsPerSec = clampInt(Number((event.target as HTMLInputElement).value), 4, 14);
  speedInput.value = String(cellsPerSec);
  speedValueEl.textContent = String(cellsPerSec);
  snake.updateOptions({ speedMs: speedToMs(cellsPerSec) });
});

mirrorCheckbox.addEventListener('change', (event) => {
  const checked = (event.target as HTMLInputElement).checked;
  motion.setMirrorHorizontal(checked);
  videoEl.style.transform = checked ? 'scaleX(-1)' : 'none';
});

videoEl.style.transform = mirrorCheckbox.checked ? 'scaleX(-1)' : 'none';

motion.onDirection((event) => {
  directionEl.textContent = directionLabel(event.direction);
  confidenceEl.textContent = `${Math.round(event.confidence * 100)}%`;

  if (snake.isRunning()) {
    snake.setDirection(event.direction);
  }
});

const monitorId = window.setInterval(() => {
  const snapshot = motion.getSnapshot();
  trackingEl.textContent = snapshot.tracking ? '正常' : '丢失';
  fpsEl.textContent = snapshot.fps > 0 ? String(snapshot.fps) : '-';
}, 180);

window.addEventListener('beforeunload', () => {
  window.clearInterval(monitorId);
  snake.stop();
  motion.stop();
});
