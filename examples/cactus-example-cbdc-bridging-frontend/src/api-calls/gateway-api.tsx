import { SessionReference } from "@hyperledger/cactus-example-cbdc-bridging-backend/src/main/typescript/types";
/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  GetSessionsReferencesApi,
  TransactApi,
  TransactRequest,
} from "@hyperledger/cactus-example-cbdc-bridging-backend/src/main/typescript/generated/openapi/typescript-axios/api";
import { Configuration } from "@hyperledger/cactus-example-cbdc-bridging-backend/src/main/typescript/generated/openapi/typescript-axios/configuration";

type BesuChainId = "BESU_A" | "BESU_B";

function toBesuChainId(ledger: "FABRIC" | "BESU"): BesuChainId {
  return ledger === "FABRIC" ? "BESU_A" : "BESU_B";
}

export async function getSessionReferencesBridge(
  path: string,
  type: "BESU" | "FABRIC",
): Promise<SessionReference[]> {
  const getSessionReferencesApi = new GetSessionsReferencesApi(
    new Configuration({ basePath: path }),
  );
  try {
    const response = await getSessionReferencesApi.getSessionsReferences(
      toBesuChainId(type) as any,
    );

    if (response.status !== 200) {
      throw Error(response.status + " :" + response.data);
    }
    console.log(response.data);
    return response.data as SessionReference[];
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

export async function transactTokens(
  path: string,
  sender: string,
  receiver: string,
  sourceChain: "FABRIC" | "BESU",
  receiverChain: "FABRIC" | "BESU",
  amount: string,
) {
  const transactApi = new TransactApi(new Configuration({ basePath: path }));
  try {
    const response = await transactApi.transact({
      sender,
      receiver,
      sourceChain: {
        assetType: toBesuChainId(sourceChain),
      },
      receiverChain: {
        assetType: toBesuChainId(receiverChain) as any,
      },
      amount,
    } as unknown as TransactRequest);

    if (response.status !== 200) {
      throw Error(response.status + " :" + response.data);
    }

    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}
