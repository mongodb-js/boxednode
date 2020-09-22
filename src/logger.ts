import chalk from 'chalk';
import cliProgress from 'cli-progress';

export interface Logger {
  stepStarting(info: string): void;
  stepCompleted(): void;
  stepFailed(err: Error): void;
  startProgress(maximum: number): void;
  doProgress(current: number): void;
}

export class LoggerImpl implements Logger {
  currentStep = '';
  cliProgress : cliProgress.SingleBar | null = null;

  stepStarting (info: string): void {
    if (this.currentStep) {
      this.stepCompleted();
    }
    this.currentStep = info;

    console.warn(`${chalk.yellow('→')}  ${info} ...`);
  }

  _stepDone (): void {
    this.currentStep = '';
    if (this.cliProgress) {
      this.cliProgress.stop();
      this.cliProgress = null;
    }
  }

  stepCompleted (): void {
    this._stepDone();
    console.warn(chalk.green(`  ✓  Completed: ${this.currentStep}`));
  }

  stepFailed (err: Error): void {
    this._stepDone();
    console.warn(chalk.red(`  ✖  Failed: ${err.message}`));
  }

  startProgress (maximum: number): void {
    this.cliProgress = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    this.cliProgress.start(maximum, 0);
  }

  doProgress (current: number): void {
    this.cliProgress.update(current);
  }
}
