import { describe, expect, it } from "vitest";
import {
  DiscoveryRegistryConflictError,
  NodeDiscoveryRegistryService,
} from "../../../../src/discovery/services/node-discovery-registry-service.js";

describe("NodeDiscoveryRegistryService", () => {
  it("announces peers and normalizes baseUrl", () => {
    const service = new NodeDiscoveryRegistryService();
    service.announce({
      nodeId: "node-a",
      nodeName: "Node A",
      baseUrl: "http://10.0.0.10:8000/",
    });

    expect(service.listPeers()).toEqual([
      expect.objectContaining({
        nodeId: "node-a",
        nodeName: "Node A",
        baseUrl: "http://10.0.0.10:8000",
        status: "ready",
      }),
    ]);
  });

  it("rejects nodeId conflict when baseUrl changes", () => {
    const service = new NodeDiscoveryRegistryService();
    service.announce({
      nodeId: "node-a",
      nodeName: "Node A",
      baseUrl: "http://10.0.0.10:8000",
    });

    expect(() =>
      service.announce({
        nodeId: "node-a",
        nodeName: "Node A",
        baseUrl: "http://10.0.0.11:8000",
      }),
    ).toThrowError(DiscoveryRegistryConflictError);
  });

  it("rejects baseUrl conflict across different nodeIds", () => {
    const service = new NodeDiscoveryRegistryService();
    service.announce({
      nodeId: "node-a",
      nodeName: "Node A",
      baseUrl: "http://10.0.0.10:8000",
    });

    expect(() =>
      service.announce({
        nodeId: "node-b",
        nodeName: "Node B",
        baseUrl: "http://10.0.0.10:8000",
      }),
    ).toThrowError(DiscoveryRegistryConflictError);
  });

  it("returns false on heartbeat for unknown node", () => {
    const service = new NodeDiscoveryRegistryService();
    expect(service.heartbeat({ nodeId: "missing" })).toBe(false);
  });

  it("applies degraded/unreachable transitions and TTL pruning", () => {
    const service = new NodeDiscoveryRegistryService({
      degradedAfterMs: 100,
      unreachableAfterMs: 200,
      ttlMs: 300,
    });

    service.announce({
      nodeId: "node-a",
      nodeName: "Node A",
      baseUrl: "http://10.0.0.10:8000",
      lastSeenAtIso: new Date(0).toISOString(),
    });

    service.tickMaintenance(150);
    expect(service.listPeers()[0]?.status).toBe("degraded");

    service.tickMaintenance(250);
    expect(service.listPeers()[0]?.status).toBe("unreachable");

    const pruned = service.tickMaintenance(350);
    expect(pruned).toEqual(["node-a"]);
    expect(service.listPeers()).toHaveLength(0);
  });

  it("emits pruned ids on mergePeers convergence", () => {
    const service = new NodeDiscoveryRegistryService();
    const events: Array<{ prunedNodeIds: string[] }> = [];
    service.onChange((event) => {
      events.push({ prunedNodeIds: [...event.prunedNodeIds] });
    });

    service.announce({
      nodeId: "node-a",
      nodeName: "Node A",
      baseUrl: "http://10.0.0.10:8000",
    });
    service.announce({
      nodeId: "node-b",
      nodeName: "Node B",
      baseUrl: "http://10.0.0.11:8000",
    });

    service.mergePeers([
      {
        nodeId: "node-b",
        nodeName: "Node B",
        baseUrl: "http://10.0.0.11:8000",
        advertisedBaseUrl: null,
        lastSeenAtIso: new Date().toISOString(),
        status: "ready",
        capabilities: null,
        trustMode: "lan_open",
      },
    ]);

    expect(service.listPeers().map((peer) => peer.nodeId)).toEqual(["node-b"]);
    expect(events.some((event) => event.prunedNodeIds.includes("node-a"))).toBe(true);
  });
});

