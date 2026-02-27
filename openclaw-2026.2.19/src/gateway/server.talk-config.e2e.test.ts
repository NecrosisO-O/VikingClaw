import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayload } from "./device-auth.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

function buildSignedOperatorDevice(scopes: string[], token = "secret") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyRaw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(publicKeyRaw);
  if (!deviceId) {
    throw new Error("failed to derive device id");
  }
  const signedAtMs = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId,
    clientId: GATEWAY_CLIENT_NAMES.TEST,
    clientMode: GATEWAY_CLIENT_MODES.TEST,
    role: "operator",
    scopes,
    signedAtMs,
    token,
  });
  return {
    id: deviceId,
    publicKey: publicKeyRaw,
    signature: signDevicePayload(privateKeyPem, payload),
    signedAt: signedAtMs,
  };
}

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        voiceId: "voice-123",
        apiKey: "secret-key-abc",
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      const scopes = ["operator.read"];
      await connectOk(ws, {
        token: "secret",
        scopes,
        device: buildSignedOperatorDevice(scopes),
      });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string; voiceId?: string } } }>(
        ws,
        "talk.config",
        {},
      );
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.apiKey).toBe("__OPENCLAW_REDACTED__");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    await withServer(async (ws) => {
      const scopes = ["operator.read"];
      await connectOk(ws, {
        token: "secret",
        scopes,
        device: buildSignedOperatorDevice(scopes),
      });
      const res = await rpcReq(ws, "talk.config", { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it("returns secrets for operator.talk.secrets scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    await withServer(async (ws) => {
      const scopes = ["operator.read", "operator.write", "operator.talk.secrets"];
      await connectOk(ws, {
        token: "secret",
        scopes,
        device: buildSignedOperatorDevice(scopes),
      });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(ws, "talk.config", {
        includeSecrets: true,
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    });
  });
});
