import {
  ILoggerOptions,
  LogLevelDesc,
  Logger,
} from "@hyperledger/cactus-common";
import { MonitorService } from "../services/monitoring/monitor";

export class Satp_Logger {
  private readonly backend: Logger;
  private readonly monitorService: MonitorService;

  constructor(
    public readonly options: ILoggerOptions,
    monitorService: MonitorService,
  ) {
    const level: LogLevelDesc = options.level || "warn";
    this.backend = new Logger({ label: options.label, level });
    this.monitorService = monitorService;
  }

  public setLogLevel(logLevel: LogLevelDesc): void {
    this.backend.setLogLevel(logLevel);
  }

  public async shutdown(): Promise<void> {
    this.monitorService.createLog("Shut down logger OK.", "info");
    this.backend.info("Shut down logger OK.");
  }

  public error(...msg: unknown[]): void {
    this.monitorService.createLog(msg.map(String).join(" "), "error");
    this.backend.error(...msg);
  }

  public warn(...msg: unknown[]): void {
    this.monitorService.createLog(msg.map(String).join(" "), "warn");
    this.backend.warn(...msg);
  }
  public info(...msg: unknown[]): void {
    this.monitorService.createLog(msg.map(String).join(" "), "info");
    this.backend.info(...msg);
  }
  public debug(...msg: unknown[]): void {
    this.monitorService.createLog(msg.map(String).join(" "), "debug");
    this.backend.debug(...msg);
  }
  public trace(...msg: unknown[]): void {
    this.monitorService.createLog(msg.map(String).join(" "), "trace");
    this.backend.trace(...msg);
  }
}
