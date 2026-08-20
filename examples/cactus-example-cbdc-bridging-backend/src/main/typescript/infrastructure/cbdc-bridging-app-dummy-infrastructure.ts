import express, { type Express } from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import bodyParser from "body-parser";
import { Knex } from "knex";

import {
  Logger,
  Checks,
  LogLevelDesc,
  LoggerProvider,
  Secp256k1Keys,
} from "@hyperledger/cactus-common";
import {
  Configuration,
  GetApproveAddressApi,
  SATPGatewayConfig,
  TokenType,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { IWebServiceEndpoint, LedgerType } from "@hyperledger/cactus-core-api";
import { GatewayIdentity } from "@hyperledger/cactus-plugin-satp-hermes";
import { SessionReference } from "../types";

import { ApproveEndpointV1 } from "../web-services/approve-endpoint";
import { GetSessionsDataEndpointV1 } from "../web-services/get-all-session-data-endpoints";
import { GetBalanceEndpointV1 } from "../web-services/get-balance-endpoint";
import { MintEndpointV1 } from "../web-services/mint-endpoint";
import { TransactEndpointV1 } from "../web-services/transact-endpoint";
import { TransferEndpointV1 } from "../web-services/transfer-endpoint";
import { GetAmountApprovedEndpointV1 } from "../web-services/get-amount-approved-endpoint";

import {
  AdminApi,
  TransactionApi,
  TransactRequest,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { BesuEnvironment } from "./cbdc-besu-environment";
import { Container } from "dockerode";
import { createPGDatabase, setupDBTable } from "./db-infrastructure";
import {
  DEFAULT_PORT_GATEWAY_CLIENT,
  DEFAULT_PORT_GATEWAY_SERVER,
  DEFAULT_PORT_GATEWAY_OAPI,
} from "@hyperledger/cactus-plugin-satp-hermes";
import { getTestConfigFilesDirectory, setupGatewayDockerFiles } from "./utils";
import {
  ISATPGatewayRunnerConstructorOptions,
  SATPGatewayRunner,
} from "@hyperledger/cactus-test-tooling";

import Docker from "dockerode";

import http from "node:http";
import { createMonitorSystem } from "./monitoring-infrastructure";

export interface ICbdcBridgingAppDummyInfrastructureOptions {
  logLevel?: LogLevelDesc;
}

export class CbdcBridgingAppDummyInfrastructure {
  public static readonly CLASS_NAME = "CbdcBridgingAppDummyInfrastructure";

  private static readonly networkName = "CDBC_Network";

  private static readonly DOCKER_IMAGE_VERSION = "5f190f37f-2025-08-19";
  private static readonly DOCKER_IMAGE_NAME =
    "kubaya/cacti-satp-hermes-gateway";

  private readonly log: Logger;
  private readonly logLevel: LogLevelDesc;

  private readonly besuEnvironmentA: BesuEnvironment;
  private readonly besuEnvironmentB: BesuEnvironment;

  private db_local_config1?: Knex.Config;
  private db_remote_config1?: Knex.Config;
  private db_local_config2?: Knex.Config;
  private db_remote_config2?: Knex.Config;
  private db_local1?: Container;
  private db_remote1?: Container;
  private db_local2?: Container;
  private db_remote2?: Container;
  private monitorService?: Container;

  private besuGatewayARunner?: SATPGatewayRunner;
  private besuGatewayBRunner?: SATPGatewayRunner;

  private besuGatewayAAddress = "besu-gateway-a.satp-hermes";
  private besuGatewayBAddress = "besu-gateway-b.satp-hermes";

  private besuGatewayAApproveAddress?: string;
  private besuGatewayBApproveAddress?: string;

  private besuGatewayATransactApi?: TransactionApi;
  private besuGatewayAAdminApi?: AdminApi;
  private besuGatewayBTransactApi?: TransactionApi;
  private besuGatewayBAdminApi?: AdminApi;

  private endpoints?: IWebServiceEndpoint[];

  private webApplication?: Express;
  private webServer?: http.Server;

  public get className(): string {
    return CbdcBridgingAppDummyInfrastructure.CLASS_NAME;
  }

  constructor(
    public readonly options: ICbdcBridgingAppDummyInfrastructureOptions,
  ) {
    const fnTag = `${this.className}#constructor()`;
    Checks.truthy(options, `${fnTag} arg options`);

    this.logLevel = (this.options.logLevel || "INFO") as LogLevelDesc;
    const label = this.className;

    this.log = LoggerProvider.getOrCreate({ level: this.logLevel, label });

    this.besuEnvironmentA = new BesuEnvironment(
      this.logLevel,
      CbdcBridgingAppDummyInfrastructure.networkName,
    );
    this.besuEnvironmentB = new BesuEnvironment(
      this.logLevel,
      CbdcBridgingAppDummyInfrastructure.networkName,
    );
  }

  public async start(): Promise<void> {
    try {
      this.log.info(`Starting dummy infrastructure... (this can take a while)`);
      this.log.info(`Starting Ledgers...`);
      // This is necessary because there is a race condition when creating networks
      const docker = new Docker();
      const networks = await docker.listNetworks();
      const networkExists = networks.some(
        (n) => n.Name === CbdcBridgingAppDummyInfrastructure.networkName,
      );
      if (!networkExists) {
        await docker.createNetwork({
          Name: CbdcBridgingAppDummyInfrastructure.networkName,
          Driver: "bridge",
        });
      }

      await Promise.all([
        this.besuEnvironmentA.init(),
        this.besuEnvironmentB.init(),
      ]);
      this.log.info(`Deploying contracts...`);
      await Promise.all([
        this.besuEnvironmentA.deployAndSetupContracts(),
        this.besuEnvironmentB.deployAndSetupContracts(),
      ]);
      this.log.info(`Creating databases...`);
      await this.createDBs();
      this.log.info(`Creating Monitoring Service...`);
      await this.createMonitorSystem();
      this.log.info(`Creating SATP Gateways...`);
      await this.createSATPGateways();
      this.log.debug("creating api server...");
      await this.createApiServer();
      this.log.debug("api server created successfully");
    } catch (ex) {
      this.log.error(`Starting of dummy infrastructure crashed: `, ex);
      throw ex;
    }
  }

  public async stop(): Promise<void> {
    try {
      this.log.info(`Stopping...`);
      await Promise.all([
        this.besuGatewayARunner?.stop(),
        this.besuGatewayBRunner?.stop(),
      ]);
      await Promise.all([
        this.besuGatewayARunner?.destroy(),
        this.besuGatewayBRunner?.destroy(),
      ]);

      await this.db_local1?.stop();
      await this.db_local1?.remove();
      await this.db_remote1?.stop();
      await this.db_remote1?.remove();
      await this.db_local2?.stop();
      await this.db_local2?.remove();
      await this.db_remote2?.stop();
      await this.db_remote2?.remove();
      await this.monitorService?.stop();
      await this.monitorService?.remove();

      await Promise.all([
        this.besuEnvironmentA.tearDown(),
        this.besuEnvironmentB.tearDown(),
      ]);

      if (this.webServer) {
        await new Promise<void>((resolve, reject) => {
          this.webServer?.close((err) => {
            if (err) {
              this.log.error(`Failed to close web server: ${err}`);
              reject(err);
            } else {
              this.log.info(`Web server closed`);
              resolve();
            }
          });
        });
      }

      this.log.info(`Stopped OK`);
    } catch (ex) {
      this.log.error(`Stopping crashed: `, ex);
      throw ex;
    }
  }

  public async createDBs() {
    ({ config: this.db_local_config1, container: this.db_local1 } =
      await createPGDatabase({
        network: CbdcBridgingAppDummyInfrastructure.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));

    ({ config: this.db_remote_config1, container: this.db_remote1 } =
      await createPGDatabase({
        network: CbdcBridgingAppDummyInfrastructure.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));

    ({ config: this.db_local_config2, container: this.db_local2 } =
      await createPGDatabase({
        network: CbdcBridgingAppDummyInfrastructure.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));

    ({ config: this.db_remote_config2, container: this.db_remote2 } =
      await createPGDatabase({
        network: CbdcBridgingAppDummyInfrastructure.networkName,
        postgresUser: "user123123",
        postgresPassword: "password",
      }));

    await setupDBTable(this.db_remote_config1);
    await setupDBTable(this.db_remote_config2);
  }

  private async createMonitorSystem(): Promise<void> {
    this.monitorService = await createMonitorSystem({});
  }

  public async createSATPGateways(): Promise<void> {
    const fnTag = `${this.className}#createSATPGateways()`;
    this.log.info(`${fnTag} Creating SATP Gateways...`);

    const besuGatewayAKeyPair = Secp256k1Keys.generateKeyPairsBuffer();
    const besuGatewayBKeyPair = Secp256k1Keys.generateKeyPairsBuffer();

    // Network A (Besu A) Gateway Identity
    const besuGatewayAIdentity = {
      id: "BesuGatewayA",
      name: "CustomGateway",
      version: [
        {
          Core: "v02",
          Architecture: "v02",
          Crash: "v02",
        },
      ],
      connectedDLTs: [
        {
          id: BesuEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
      ],
      proofID: "mockProofID10",
      address: `http://${this.besuGatewayAAddress}`,
      gatewayClientPort: DEFAULT_PORT_GATEWAY_CLIENT,
      gatewayServerPort: DEFAULT_PORT_GATEWAY_SERVER,
      gatewayOapiPort: DEFAULT_PORT_GATEWAY_OAPI,
      pubKey: Buffer.from(besuGatewayAKeyPair.publicKey).toString("hex"),
    } as GatewayIdentity;

    // Network B (Besu B) Gateway Identity
    const besuGatewayBIdentity = {
      id: "BesuGatewayB",
      name: "CustomGateway",
      version: [
        {
          Core: "v02",
          Architecture: "v02",
          Crash: "v02",
        },
      ],
      connectedDLTs: [
        {
          id: BesuEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
      ],
      proofID: "mockProofID11",
      address: `http://${this.besuGatewayBAddress}`,
      gatewayClientPort: DEFAULT_PORT_GATEWAY_CLIENT,
      gatewayServerPort: DEFAULT_PORT_GATEWAY_SERVER,
      gatewayOapiPort: DEFAULT_PORT_GATEWAY_OAPI,
      pubKey: Buffer.from(besuGatewayBKeyPair.publicKey).toString("hex"),
    } as GatewayIdentity;

    const besuConfigA = await this.besuEnvironmentA.createBesuDockerConfig();
    const besuConfigB = await this.besuEnvironmentB.createBesuDockerConfig();

    const besuGatewayAOptions: Partial<SATPGatewayConfig> = {
      gid: besuGatewayAIdentity,
      logLevel: this.logLevel,
      counterPartyGateways: [besuGatewayBIdentity],
      localRepository: this.db_local_config1
        ? ({
            client: this.db_local_config1.client,
            connection: this.db_local_config1.connection,
          } as Knex.Config)
        : undefined,
      remoteRepository: this.db_remote_config1
        ? ({
            client: this.db_remote_config1.client,
            connection: this.db_remote_config1.connection,
          } as Knex.Config)
        : undefined,
      environment: "production",
      ccConfig: {
        bridgeConfig: [besuConfigA],
      },
      enableCrashRecovery: false,
      keyPair: {
        publicKey: Buffer.from(besuGatewayAKeyPair.publicKey).toString("hex"),
        privateKey: besuGatewayAKeyPair.privateKey.toString("hex"),
      },
      ontologyPath: "/opt/cacti/satp-hermes/ontologies",
    };

    const besuGatewayBOptions: Partial<SATPGatewayConfig> = {
      gid: besuGatewayBIdentity,
      logLevel: this.logLevel,
      counterPartyGateways: [besuGatewayAIdentity],
      localRepository: this.db_local_config2
        ? ({
            client: this.db_local_config2.client,
            connection: this.db_local_config2.connection,
          } as Knex.Config)
        : undefined,
      remoteRepository: this.db_remote_config2
        ? ({
            client: this.db_remote_config2.client,
            connection: this.db_remote_config2.connection,
          } as Knex.Config)
        : undefined,
      environment: "production",
      ccConfig: {
        bridgeConfig: [besuConfigB],
      },
      enableCrashRecovery: false,
      keyPair: {
        publicKey: Buffer.from(besuGatewayBKeyPair.publicKey).toString("hex"),
        privateKey: besuGatewayBKeyPair.privateKey.toString("hex"),
      },
      ontologyPath: "/opt/cacti/satp-hermes/ontologies",
    };

    const besuGatewayADockerFiles = setupGatewayDockerFiles(
      besuGatewayAOptions,
    );
    const besuGatewayBDockerFiles = setupGatewayDockerFiles(
      besuGatewayBOptions,
    );

    const besuGatewayARunnerOptions: ISATPGatewayRunnerConstructorOptions = {
      containerImageVersion:
        CbdcBridgingAppDummyInfrastructure.DOCKER_IMAGE_VERSION,
      containerImageName: CbdcBridgingAppDummyInfrastructure.DOCKER_IMAGE_NAME,
      serverPort: DEFAULT_PORT_GATEWAY_SERVER,
      clientPort: DEFAULT_PORT_GATEWAY_CLIENT,
      oapiPort: DEFAULT_PORT_GATEWAY_OAPI,
      logLevel: this.logLevel,
      emitContainerLogs: true,
      configPath: besuGatewayADockerFiles.configPath,
      logsPath: besuGatewayADockerFiles.logsPath,
      ontologiesPath: besuGatewayADockerFiles.ontologiesPath,
      networkName: CbdcBridgingAppDummyInfrastructure.networkName,
      url: this.besuGatewayAAddress,
    };

    const besuGatewayBRunnerOptions: ISATPGatewayRunnerConstructorOptions = {
      containerImageVersion:
        CbdcBridgingAppDummyInfrastructure.DOCKER_IMAGE_VERSION,
      containerImageName: CbdcBridgingAppDummyInfrastructure.DOCKER_IMAGE_NAME,
      serverPort: DEFAULT_PORT_GATEWAY_SERVER + 100,
      clientPort: DEFAULT_PORT_GATEWAY_CLIENT + 100,
      oapiPort: DEFAULT_PORT_GATEWAY_OAPI + 100,
      logLevel: this.logLevel,
      emitContainerLogs: true,
      configPath: besuGatewayBDockerFiles.configPath,
      logsPath: besuGatewayBDockerFiles.logsPath,
      ontologiesPath: besuGatewayBDockerFiles.ontologiesPath,
      networkName: CbdcBridgingAppDummyInfrastructure.networkName,
      url: this.besuGatewayBAddress,
    };

    this.besuGatewayARunner = new SATPGatewayRunner(
      besuGatewayARunnerOptions,
    );
    this.log.debug("starting Besu gateway runner A");
    await this.besuGatewayARunner.start();

    this.besuGatewayBRunner = new SATPGatewayRunner(
      besuGatewayBRunnerOptions,
    );
    this.log.debug("starting Besu gateway runner B");
    await this.besuGatewayBRunner.start();
    this.log.debug("Besu gateway runners started successfully");

    const besuGatewayAApproveAddressApi = new GetApproveAddressApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayARunner.getOApiHost()}`,
      }),
    );

    const reqApproveBesuAAddress =
      await besuGatewayAApproveAddressApi.getApproveAddress(
        {
          id: BesuEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
        TokenType.Fungible,
      );

    if (!reqApproveBesuAAddress?.data.approveAddress) {
      throw new Error("Approve address for Besu A is undefined");
    }

    this.besuGatewayAApproveAddress = reqApproveBesuAAddress.data.approveAddress;
    this.besuEnvironmentA.setApproveAddress(this.besuGatewayAApproveAddress);

    const besuGatewayBApproveAddressApi = new GetApproveAddressApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayBRunner.getOApiHost()}`,
      }),
    );
    const reqApproveBesuBAddress =
      await besuGatewayBApproveAddressApi.getApproveAddress(
        {
          id: BesuEnvironment.BESU_NETWORK_ID,
          ledgerType: LedgerType.Besu2X,
        },
        TokenType.Fungible,
      );

    if (!reqApproveBesuBAddress?.data.approveAddress) {
      throw new Error("Approve address for Besu B is undefined");
    }

    this.besuGatewayBApproveAddress = reqApproveBesuBAddress.data.approveAddress;
    this.besuEnvironmentB.setApproveAddress(this.besuGatewayBApproveAddress);

    if (!this.besuGatewayAApproveAddress) {
      throw new Error("Besu A approve address is undefined");
    }
    await this.besuEnvironmentA.giveRoleToBridge(
      this.besuGatewayAApproveAddress,
    );

    if (!this.besuGatewayBApproveAddress) {
      throw new Error("Besu B approve address is undefined");
    }
    await this.besuEnvironmentB.giveRoleToBridge(
      this.besuGatewayBApproveAddress,
    );

    this.besuGatewayATransactApi = new TransactionApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayARunner.getOApiHost()}`,
      }),
    );
    this.besuGatewayAAdminApi = new AdminApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayARunner.getOApiHost()}`,
      }),
    );
    this.besuGatewayBTransactApi = new TransactionApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayBRunner.getOApiHost()}`,
      }),
    );
    this.besuGatewayBAdminApi = new AdminApi(
      new Configuration({
        basePath: `http://${await this.besuGatewayBRunner.getOApiHost()}`,
      }),
    );

    this.log.info(`SATP Gateways created`);
  }

  private async createApiServer(): Promise<void> {
    this.webApplication = express();
    this.webApplication.use(bodyParser.json({ limit: "250mb" }));
    this.webApplication.use(cors());
    const webServices = await this.getOrCreateWebServices();

    try {
      for (const service of webServices) {
        this.log.debug(`Registering web service: ${service.getPath()}`);
        await service.registerExpress(this.webApplication);
      }
    } catch (ex) {
      this.log.error(`Failed to register web services: `, ex);
      throw ex;
    }
    this.webServer = http.createServer(this.webApplication);

    await new Promise<void>((resolve, reject) => {
      if (!this.webServer) {
        throw new Error("web server is not defined");
      }
      this.webServer.listen(9999, () => {
        this.log.info(`web server started and listening on port ${9999}`);
        resolve();
      });
      this.webServer.on("error", (error) => {
        this.log.error(`web server failed to start: ${error}`);
        reject(error);
      });
    });
  }

  public async getOrCreateWebServices(): Promise<IWebServiceEndpoint[]> {
    const fnTag = `${CbdcBridgingAppDummyInfrastructure.CLASS_NAME}#getOrCreateWebServices()`;
    this.log.info(`${fnTag}, Registering webservices`);

    if (Array.isArray(this.endpoints)) {
      return this.endpoints;
    }

    const approveEndpointV1 = new ApproveEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const gelAllSessionDataEndpointV1 = new GetSessionsDataEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const getBalanceEndpointV1 = new GetBalanceEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const mintEndpointV1 = new MintEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const transactEndpointV1 = new TransactEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const transferEndpointV1 = new TransferEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const getApprovedEndpointV1 = new GetAmountApprovedEndpointV1({
      infrastructure: this,
      logLevel: this.options.logLevel,
    });

    const theEndpoints = [
      approveEndpointV1,
      gelAllSessionDataEndpointV1,
      getBalanceEndpointV1,
      mintEndpointV1,
      transactEndpointV1,
      transferEndpointV1,
      getApprovedEndpointV1,
    ];
    this.endpoints = theEndpoints;

    return theEndpoints;
  }

  public getBesuEnvironmentA(): BesuEnvironment {
    return this.besuEnvironmentA;
  }

  public getBesuEnvironmentB(): BesuEnvironment {
    return this.besuEnvironmentB;
  }

  public async getSessionsData(gateway: string): Promise<SessionReference[]> {
    this.log.debug(`Getting sessions data from ${gateway}`);
    let api;
    if (gateway === "BESU_A") {
      api = this.besuGatewayAAdminApi;
    } else if (gateway === "BESU_B") {
      api = this.besuGatewayBAdminApi;
    } else {
      throw new Error(`Unknown gateway: ${gateway}`);
    }
    try {
      if (api === undefined) {
        throw new Error("API is undefined");
      }
      const response = await api.getSessionIds();

      if (response.status !== 200) {
        return [
          {
            id: "MockID",
            status: "undefined",
            substatus: "undefined",
            sourceLedger: "undefined",
            receiverLedger: "undefined",
          },
        ];
      }

      const ids = response.data;

      const sessionsData = [];
      for (const id of ids) {
        try {
          const sessionData = await api.getStatus(id);
          const data: SessionReference = {
            id,
            status: sessionData.data.status,
            substatus: sessionData.data.substatus,
            sourceLedger: sessionData.data.originNetwork.dltProtocol,
            receiverLedger: sessionData.data.destinationNetwork.dltProtocol,
          };

          sessionsData.push(data);
        } catch (error) {
          sessionsData.push({
            id: "MockID",
            status: "undefined",
            substatus: "undefined",
            sourceLedger: "undefined",
            receiverLedger: "undefined",
          });
        }
      }
      return sessionsData;
    } catch (error) {
      console.log(error);
      return [
        {
          id: "MockID",
          status: "undefined",
          substatus: "undefined",
          sourceLedger: "undefined",
          receiverLedger: "undefined",
        },
      ];
    }
  }

  public async bridgeTokens(
    sender: string,
    recipient: string,
    sourceChain: string,
    destinationChain: string,
    amount: number,
  ) {
    this.log.debug(
      `Bridging tokens from ${sourceChain} to ${destinationChain}`,
    );
    let sourceAsset;
    let receiverAsset;

    let api;

    if (sourceChain === "BESU_A") {
      const besuSenderAddress = this.besuEnvironmentA.getEthAddress(sender);
      if (!besuSenderAddress) {
        throw new Error(`Besu A sender address not found for ${sender}`);
      }
      sourceAsset = this.besuEnvironmentA.getBesuAsset(
        besuSenderAddress,
        amount.toString(),
      );
      api = this.besuGatewayATransactApi;
    } else if (sourceChain === "BESU_B") {
      const besuSenderAddress = this.besuEnvironmentB.getEthAddress(sender);
      if (!besuSenderAddress) {
        throw new Error(`Besu B sender address not found for ${sender}`);
      }
      sourceAsset = this.besuEnvironmentB.getBesuAsset(
        besuSenderAddress,
        amount.toString(),
      );
      api = this.besuGatewayBTransactApi;
    } else {
      throw new Error(`Unknown source chain: ${sourceChain}`);
    }

    if (destinationChain === "BESU_A") {
      const besuReceiverAddress = this.besuEnvironmentA.getEthAddress(recipient);
      if (!besuReceiverAddress) {
        throw new Error(`Besu A recipient address not found for ${recipient}`);
      }
      receiverAsset = this.besuEnvironmentA.getBesuAsset(
        besuReceiverAddress,
        amount.toString(),
      );
    } else if (destinationChain === "BESU_B") {
      const besuReceiverAddress = this.besuEnvironmentB.getEthAddress(recipient);
      if (!besuReceiverAddress) {
        throw new Error(`Besu B recipient address not found for ${recipient}`);
      }
      receiverAsset = this.besuEnvironmentB.getBesuAsset(
        besuReceiverAddress,
        amount.toString(),
      );
    } else {
      throw new Error(`Unknown destination chain: ${destinationChain}`);
    }

    if (api === undefined) {
      throw new Error("API is undefined");
    }

    try {
      const request: TransactRequest = {
        contextID: uuidv4(),
        sourceAsset,
        receiverAsset,
      };
      await api.transact(request);
    } catch (error) {
      this.log.error(
        `Error bridging tokens from ${sourceChain} to ${destinationChain}`,
      );
      throw error;
    }
  }
}
