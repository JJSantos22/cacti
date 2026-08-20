import {
  ApproveApi,
  GetAmountApprovedApi,
  GetBalanceApi,
  MintApi,
  MintRequest,
  TransferApi,
} from "@hyperledger/cactus-example-cbdc-bridging-backend/src/main/typescript/generated/openapi/typescript-axios/api";
import { Configuration } from "@hyperledger/cactus-example-cbdc-bridging-backend/src/main/typescript/generated/openapi/typescript-axios/configuration";

type BesuChainId = "BESU_A" | "BESU_B";

function toBesuChainId(ledger: "FABRIC" | "BESU"): BesuChainId {
  return ledger === "FABRIC" ? "BESU_A" : "BESU_B";
}

export async function approveNTokens(
  path: string,
  ledger: "FABRIC" | "BESU",
  frontendUserFrom: string,
  amount: string,
) {
  const approveApi = new ApproveApi(new Configuration({ basePath: path }));
  try {
    const res = await approveApi.approve({
      user: frontendUserFrom,
      amount: amount,
      ledger: {
        assetType: toBesuChainId(ledger) as any,
      },
    } as any);

    if (res.status !== 200) {
      throw Error(res.status + " :" + res.data);
    }

    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function fetchAmountApprovedToBridge(
  path: string,
  ledger: "FABRIC" | "BESU",
  frontendUser: string,
) {
  const getAmountApprovedApi = new GetAmountApprovedApi(
    new Configuration({ basePath: path }),
  );

  try {
    const response = await getAmountApprovedApi.getAmountApproved(
      frontendUser,
      toBesuChainId(ledger) as any,
    );

    if (response.status !== 200) {
      throw Error(response.status + " :" + response.data);
    }
    return parseInt(response.data);
  } catch (error) {
    console.error(error);
  }
}

export async function transferTokens(
  path: string,
  ledger: "FABRIC" | "BESU",
  frontendUserFrom: string,
  frontendUserTo: string,
  amount: string,
) {
  let receiverLedger: BesuChainId;
  if (ledger === "FABRIC") {
    receiverLedger = "BESU_B";
  } else {
    receiverLedger = "BESU_A";
  }
  const transferApi = new TransferApi(new Configuration({ basePath: path }));
  try {
    const res = await transferApi.transfer({
      from: frontendUserFrom,
      to: frontendUserTo,
      amount: amount,
      sourceChain: {
        assetType: toBesuChainId(ledger) as any,
      },
      receiverChain: {
        assetType: receiverLedger as any,
      },
    } as any);

    if (res.status !== 200) {
      throw Error(res.status + " :" + res.data);
    }
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}

export async function getBalance(
  path: string,
  ledger: "FABRIC" | "BESU",
  frontendUser: string,
) {
  const getBalanceApi = new GetBalanceApi(
    new Configuration({ basePath: path }),
  );
  try {
    const response = await getBalanceApi.getBalance(
      frontendUser,
      toBesuChainId(ledger) as any,
    );

    if (response.status !== 200) {
      throw Error(response.status + " :" + response.data);
    }
    if (response.data === undefined) {
      return 0;
    }
    return parseInt(response.data.amount);
  } catch (error) {
    console.error(error);
    return -1;
  }
}
export async function mintTokens(
  path: string,
  ledger: "FABRIC" | "BESU",
  user: string,
  amount: string,
) {
  const mintApi = new MintApi(new Configuration({ basePath: path }));
  try {
    const response = await mintApi.mint({
      user: user,
      amount: amount,
      ledger: {
        assetType: toBesuChainId(ledger) as any,
      },
    } as unknown as MintRequest);

    if (response.status !== 200) {
      throw Error(response.status + " :" + response.data);
    }
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}
