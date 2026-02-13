import { describe, expect, it, vi } from 'vitest';
import { FederatedCatalogService } from '../../../src/federation/catalog/federated-catalog-service.js';

describe('FederatedCatalogService', () => {
  it('aggregates local and remote node catalogs', async () => {
    const service = new FederatedCatalogService({
      agentDefinitionService: {
        getAllAgentDefinitions: vi.fn().mockResolvedValue([
          {
            id: '10',
            name: 'Local Agent',
            role: 'coordinator',
            description: 'Local helper',
            avatarUrl: '/images/local-agent.png',
            toolNames: ['tool.local.1', 'tool.local.2'],
            skillNames: ['skill.local.1'],
          },
        ]),
      } as any,
      agentTeamDefinitionService: {
        getAllDefinitions: vi.fn().mockResolvedValue([
          {
            id: '20',
            name: 'Local Team',
            description: 'Local team',
            role: 'orchestrator',
            avatarUrl: '/images/local-team.png',
            coordinatorMemberName: 'leader',
            nodes: [
              { referenceType: 'AGENT' },
              { referenceType: 'AGENT_TEAM' },
            ],
          },
        ]),
      } as any,
      nodeCatalogRemoteClient: {
        fetchNodeCatalog: vi.fn().mockResolvedValue({
          nodeId: 'remote-node',
          nodeName: 'Remote Node',
          baseUrl: 'http://localhost:8100',
          status: 'ready',
          errorMessage: null,
          agents: [
            {
              homeNodeId: 'remote-node',
              definitionId: 'r-agent',
              name: 'Remote Agent',
              role: 'worker',
              description: 'Remote worker',
              avatarUrl: null,
              toolNames: [],
              skillNames: [],
            },
          ],
          teams: [],
        }),
      } as any,
    });

    const result = await service.listCatalogByNodes({
      nodes: [
        {
          nodeId: 'embedded-local',
          nodeName: 'Embedded Node',
          baseUrl: 'http://localhost:8000',
          nodeType: 'embedded',
        },
        {
          nodeId: 'remote-node',
          nodeName: 'Remote Node',
          baseUrl: 'http://localhost:8100',
          nodeType: 'remote',
        },
      ],
    });

    expect(result).toHaveLength(2);
    expect(result[0]?.nodeId).toBe('embedded-local');
    expect(result[0]?.agents[0]?.definitionId).toBe('10');
    expect(result[0]?.agents[0]?.avatarUrl).toBe('http://localhost:8000/images/local-agent.png');
    expect(result[0]?.agents[0]?.toolNames).toEqual(['tool.local.1', 'tool.local.2']);
    expect(result[0]?.agents[0]?.skillNames).toEqual(['skill.local.1']);
    expect(result[0]?.teams[0]?.memberCount).toBe(2);
    expect(result[0]?.teams[0]?.nestedTeamCount).toBe(1);
    expect(result[0]?.teams[0]?.avatarUrl).toBe('http://localhost:8000/images/local-team.png');
    expect(result[1]?.nodeId).toBe('remote-node');
    expect(result[1]?.agents[0]?.definitionId).toBe('r-agent');
  });

  it('returns degraded local scope on local service failure', async () => {
    const service = new FederatedCatalogService({
      agentDefinitionService: {
        getAllAgentDefinitions: vi.fn().mockRejectedValue(new Error('db unavailable')),
      } as any,
      agentTeamDefinitionService: {
        getAllDefinitions: vi.fn().mockResolvedValue([]),
      } as any,
      nodeCatalogRemoteClient: {
        fetchNodeCatalog: vi.fn(),
      } as any,
    });

    const [scope] = await service.listCatalogByNodes({
      nodes: [
        {
          nodeId: 'embedded-local',
          nodeName: 'Embedded Node',
          baseUrl: 'http://localhost:8000',
          nodeType: 'embedded',
        },
      ],
    });

    expect(scope?.status).toBe('degraded');
    expect(scope?.errorMessage).toMatch(/db unavailable/);
  });
});
