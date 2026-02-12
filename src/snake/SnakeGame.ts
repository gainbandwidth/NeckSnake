import type { HeadDirection } from '../motion/HeadMotionController';

interface Point {
  x: number;
  y: number;
}

interface SnakeGameCallbacks {
  onScoreChange: (score: number) => void;
  onGameOver: (finalScore: number) => void;
}

export interface SnakeGameOptions {
  cols: number;
  rows: number;
  wrapAround: boolean;
  speedMs: number;
}

export interface SnakeGameOptionUpdateResult {
  gridChanged: boolean;
  speedChanged: boolean;
  restarted: boolean;
}

const DEFAULT_OPTIONS: SnakeGameOptions = {
  cols: 28,
  rows: 18,
  wrapAround: false,
  speedMs: 140
};

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
};

export class SnakeGame {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: SnakeGameCallbacks;

  private cols: number;
  private rows: number;
  private wrapAround: boolean;
  private speedMs: number;

  private cell = 20;
  private snake: Point[] = [];
  private food: Point = { x: 0, y: 0 };

  private direction: Point = { x: 1, y: 0 };
  private nextDirection: Point = { x: 1, y: 0 };

  private running = false;
  private tickId: number | null = null;
  private score = 0;

  constructor(canvas: HTMLCanvasElement, callbacks: SnakeGameCallbacks, options: Partial<SnakeGameOptions> = {}) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Canvas 2D context is not available.');
    }

    this.canvas = canvas;
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.cols = clampInt(options.cols ?? DEFAULT_OPTIONS.cols, 12, 60);
    this.rows = clampInt(options.rows ?? DEFAULT_OPTIONS.rows, 10, 40);
    this.wrapAround = options.wrapAround ?? DEFAULT_OPTIONS.wrapAround;
    this.speedMs = clampInt(options.speedMs ?? DEFAULT_OPTIONS.speedMs, 50, 400);

    this.resize();
    this.reset();
    this.draw();
  }

  start(): void {
    this.stop();
    this.reset();
    this.running = true;
    this.startTicker();
  }

  stop(): void {
    this.running = false;
    if (this.tickId !== null) {
      window.clearInterval(this.tickId);
      this.tickId = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getScore(): number {
    return this.score;
  }

  getOptions(): SnakeGameOptions {
    return {
      cols: this.cols,
      rows: this.rows,
      wrapAround: this.wrapAround,
      speedMs: this.speedMs
    };
  }

  updateOptions(next: Partial<SnakeGameOptions>): SnakeGameOptionUpdateResult {
    const prevCols = this.cols;
    const prevRows = this.rows;
    const prevSpeedMs = this.speedMs;

    if (next.cols !== undefined) {
      this.cols = clampInt(next.cols, 12, 60);
    }
    if (next.rows !== undefined) {
      this.rows = clampInt(next.rows, 10, 40);
    }
    if (next.wrapAround !== undefined) {
      this.wrapAround = next.wrapAround;
    }
    if (next.speedMs !== undefined) {
      this.speedMs = clampInt(next.speedMs, 50, 400);
    }

    const gridChanged = prevCols !== this.cols || prevRows !== this.rows;
    const speedChanged = prevSpeedMs !== this.speedMs;
    const wasRunning = this.running;

    if (gridChanged) {
      this.stop();
      this.resize();
      this.reset();
      if (wasRunning) {
        this.running = true;
        this.startTicker();
      } else {
        this.draw();
      }
      return {
        gridChanged,
        speedChanged,
        restarted: wasRunning
      };
    }

    if (wasRunning && speedChanged) {
      this.startTicker();
    }
    this.draw();

    return {
      gridChanged,
      speedChanged,
      restarted: false
    };
  }

  setDirection(direction: HeadDirection): void {
    const current = this.nextDirection;

    if (direction === 'up' && current.y === 0) {
      this.nextDirection = { x: 0, y: -1 };
      return;
    }

    if (direction === 'down' && current.y === 0) {
      this.nextDirection = { x: 0, y: 1 };
      return;
    }

    if (direction === 'left' && current.x === 0) {
      this.nextDirection = { x: -1, y: 0 };
      return;
    }

    if (direction === 'right' && current.x === 0) {
      this.nextDirection = { x: 1, y: 0 };
    }
  }

  resize(): void {
    const displayWidth = this.canvas.clientWidth || 840;
    const displayHeight = this.canvas.clientHeight || 540;

    const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
    this.canvas.width = displayWidth * dpr;
    this.canvas.height = displayHeight * dpr;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cell = Math.floor(Math.min(displayWidth / this.cols, displayHeight / this.rows));
    this.draw();
  }

  private tick(): void {
    if (!this.running) {
      return;
    }

    const head = this.snake[0];
    if (!head) {
      return;
    }

    this.direction = this.nextDirection;
    let nextX = head.x + this.direction.x;
    let nextY = head.y + this.direction.y;

    const hitsWall = nextX < 0 || nextX >= this.cols || nextY < 0 || nextY >= this.rows;

    if (hitsWall && !this.wrapAround) {
      this.stop();
      this.draw();
      this.callbacks.onGameOver(this.score);
      return;
    }

    if (this.wrapAround) {
      if (nextX < 0) {
        nextX = this.cols - 1;
      } else if (nextX >= this.cols) {
        nextX = 0;
      }
      if (nextY < 0) {
        nextY = this.rows - 1;
      } else if (nextY >= this.rows) {
        nextY = 0;
      }
    }

    const nextHead: Point = { x: nextX, y: nextY };
    const willGrow = nextHead.x === this.food.x && nextHead.y === this.food.y;
    const bodyToCheck = willGrow ? this.snake : this.snake.slice(0, -1);
    const hitsBody = bodyToCheck.some((part) => part.x === nextHead.x && part.y === nextHead.y);

    if (hitsBody) {
      this.stop();
      this.draw();
      this.callbacks.onGameOver(this.score);
      return;
    }

    this.snake.unshift(nextHead);

    if (willGrow) {
      this.score += 1;
      this.callbacks.onScoreChange(this.score);
      this.spawnFood();
    } else {
      this.snake.pop();
    }

    this.draw();
  }

  private reset(): void {
    const centerX = Math.floor(this.cols / 2);
    const centerY = Math.floor(this.rows / 2);
    this.snake = [
      { x: centerX, y: centerY },
      { x: centerX - 1, y: centerY },
      { x: centerX - 2, y: centerY }
    ];

    this.direction = { x: 1, y: 0 };
    this.nextDirection = { x: 1, y: 0 };
    this.score = 0;
    this.callbacks.onScoreChange(this.score);
    this.spawnFood();
  }

  private spawnFood(): void {
    let next = { x: 0, y: 0 };
    do {
      next = {
        x: Math.floor(Math.random() * this.cols),
        y: Math.floor(Math.random() * this.rows)
      };
    } while (this.snake.some((part) => part.x === next.x && part.y === next.y));

    this.food = next;
  }

  private draw(): void {
    const width = this.cols * this.cell;
    const height = this.rows * this.cell;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    this.ctx.fillStyle = '#04140d';
    this.ctx.fillRect(0, 0, width, height);

    this.ctx.strokeStyle = 'rgba(27, 106, 75, 0.45)';
    this.ctx.lineWidth = 1;

    for (let x = 0; x <= this.cols; x += 1) {
      this.ctx.beginPath();
      this.ctx.moveTo(x * this.cell + 0.5, 0);
      this.ctx.lineTo(x * this.cell + 0.5, height);
      this.ctx.stroke();
    }

    for (let y = 0; y <= this.rows; y += 1) {
      this.ctx.beginPath();
      this.ctx.moveTo(0, y * this.cell + 0.5);
      this.ctx.lineTo(width, y * this.cell + 0.5);
      this.ctx.stroke();
    }

    this.ctx.fillStyle = '#ff6a4d';
    this.ctx.beginPath();
    this.ctx.arc(
      this.food.x * this.cell + this.cell / 2,
      this.food.y * this.cell + this.cell / 2,
      this.cell * 0.3,
      0,
      Math.PI * 2
    );
    this.ctx.fill();

    this.snake.forEach((part, index) => {
      this.ctx.fillStyle = index === 0 ? '#d6ffd8' : '#22f39b';
      this.ctx.fillRect(
        part.x * this.cell + 2,
        part.y * this.cell + 2,
        this.cell - 4,
        this.cell - 4
      );
    });
  }

  private startTicker(): void {
    if (this.tickId !== null) {
      window.clearInterval(this.tickId);
    }
    this.tickId = window.setInterval(() => this.tick(), this.speedMs);
  }
}
