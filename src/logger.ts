import chalk from 'chalk';

export interface Logger {
  stepStarting(info: string): void;
  stepCompleted(): void;
  stepFailed(err: Error): void;
}

export class LoggerImpl implements Logger {
  currentStep = '';

  stepStarting (info: string): void {
    if (this.currentStep) {
      this.stepCompleted();
    }
    this.currentStep = info;

    console.warn(`${chalk.yellow('→')}  ${info} ...`);
  }

  stepCompleted (): void {
    console.warn(chalk.green(`  ✓  Completed: ${this.currentStep}`));
    this.currentStep = '';
  }

  stepFailed (err: Error): void {
    console.warn(chalk.red(`  ✖ $ Failed: ${err.message}`));
    this.currentStep = '';
  }
}
