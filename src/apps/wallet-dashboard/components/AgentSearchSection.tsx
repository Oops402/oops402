import { useState, useEffect } from "react";
import { AgentSummary, AgentSearchResponse } from "../types";
import { styles } from "../styles";
import { checkAuthError } from "../utils/auth";
import { PromoteModal } from "./PromoteModal";

interface AgentSearchSectionProps {
  onAgentSelect?: (agent: AgentSummary) => void;
}

export function AgentSearchSection({ onAgentSelect }: AgentSearchSectionProps) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  
  // Search filters
  const [searchMode, setSearchMode] = useState<"regular" | "reputation">("regular");
  const [name, setName] = useState("");
  const [mcp, setMcp] = useState<boolean | undefined>(undefined);
  const [a2a, setA2a] = useState<boolean | undefined>(undefined);
  const [a2aSkills, setA2aSkills] = useState("");
  const [mcpTools, setMcpTools] = useState("");
  const [tags, setTags] = useState("");
  const [minAverageScore, setMinAverageScore] = useState("");
  const [active, setActive] = useState<boolean | undefined>(undefined);
  const [x402support, setX402support] = useState(true);
  
  // Pagination
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [pageSize] = useState(20);
  
  // Promotion modal state
  const [promoteModal, setPromoteModal] = useState<{
    resourceUrl: string;
    resourceType: 'bazaar' | 'agent';
    agentId?: string;
  } | null>(null);

  // Don't load on mount - wait for user to search

  const loadAgents = async (newCursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      
      if (searchMode === "reputation") {
        params.append("searchByReputation", "true");
        if (tags) {
          tags.split(",").forEach(tag => params.append("tags", tag.trim()));
        }
        if (minAverageScore) {
          params.append("minAverageScore", minAverageScore);
        }
        if (a2aSkills) {
          a2aSkills.split(",").forEach(skill => params.append("a2aSkills", skill.trim()));
        }
        if (name) {
          params.append("name", name);
        }
      } else {
        if (name) {
          params.append("name", name);
        }
        if (mcp !== undefined) {
          params.append("mcp", mcp.toString());
        }
        if (a2a !== undefined) {
          params.append("a2a", a2a.toString());
        }
        if (a2aSkills) {
          a2aSkills.split(",").forEach(skill => params.append("a2aSkills", skill.trim()));
        }
        if (mcpTools) {
          mcpTools.split(",").forEach(tool => params.append("mcpTools", tool.trim()));
        }
        if (active !== undefined) {
          params.append("active", active.toString());
        }
        if (x402support !== undefined) {
          params.append("x402support", x402support.toString());
        }
      }
      
      params.append("pageSize", pageSize.toString());
      if (newCursor) {
        params.append("cursor", newCursor);
      }
      
      const response = await fetch(`/api/discover/agents?${params.toString()}`, {
        credentials: "include",
      });
      
      if (await checkAuthError(response)) {
        return;
      }
      
      if (!response.ok) {
        throw new Error(`Failed to load agents: ${response.statusText}`);
      }
      
      const data: AgentSearchResponse = await response.json();
      setAgents(data.items || []);
      setNextCursor(data.nextCursor);
      setCursor(newCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agents");
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setCursor(undefined);
    loadAgents();
  };

  const handleNext = () => {
    if (nextCursor) {
      loadAgents(nextCursor);
    }
  };

  const handlePrevious = () => {
    // Note: Cursor-based pagination typically doesn't support going back
    // This is a simplified implementation
    setCursor(undefined);
    loadAgents();
  };

  const toggleExpand = (agentId: string) => {
    setExpandedAgents(prev => ({
      ...prev,
      [agentId]: !prev[agentId],
    }));
  };

  return (
    <div style={styles.section}>
      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>Search Agents</h2>
      </div>
      <div style={styles.discoveryContent}>
        {/* Search Mode Toggle */}
        <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
          <button
            onClick={() => setSearchMode("regular")}
            style={{
              ...styles.buttonSecondary,
              ...(searchMode === "regular" ? { background: "#0052FF", color: "white" } : {}),
            }}
            className="button-secondary"
          >
            Regular Search
          </button>
          <button
            onClick={() => setSearchMode("reputation")}
            style={{
              ...styles.buttonSecondary,
              ...(searchMode === "reputation" ? { background: "#0052FF", color: "white" } : {}),
            }}
            className="button-secondary"
          >
            Search by Rating
          </button>
        </div>

        {/* Search Filters */}
        <div style={styles.searchContainer} className="search-container">
          <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
            <div style={styles.formGroup}>
              <label style={styles.label}>Agent Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Search by name..."
                style={styles.input}
                className="input"
              />
            </div>

            {searchMode === "regular" ? (
              <>
                <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap", marginBottom: "0.5rem" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={mcp === true}
                      onChange={(e) => setMcp(e.target.checked ? true : undefined)}
                    />
                    <span>Has MCP endpoints</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={a2a === true}
                      onChange={(e) => setA2a(e.target.checked ? true : undefined)}
                    />
                    <span>Has A2A endpoints</span>
                  </label>
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>A2A Skills (comma-separated)</label>
                  <input
                    type="text"
                    value={a2aSkills}
                    onChange={(e) => setA2aSkills(e.target.value)}
                    placeholder="e.g., python, javascript"
                    style={styles.input}
                    className="input"
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>MCP Tools (comma-separated)</label>
                  <input
                    type="text"
                    value={mcpTools}
                    onChange={(e) => setMcpTools(e.target.value)}
                    placeholder="e.g., code_generation, analysis"
                    style={styles.input}
                    className="input"
                  />
                </div>
                <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={active === true}
                      onChange={(e) => setActive(e.target.checked ? true : undefined)}
                    />
                    <span>Active only</span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={x402support}
                      onChange={(e) => setX402support(e.target.checked)}
                    />
                    <span>x402 Support</span>
                  </label>
                </div>
              </>
            ) : (
              <>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Tags (comma-separated)</label>
                  <input
                    type="text"
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="e.g., enterprise, production"
                    style={styles.input}
                    className="input"
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>Minimum Average Score</label>
                  <input
                    type="number"
                    value={minAverageScore}
                    onChange={(e) => setMinAverageScore(e.target.value)}
                    placeholder="e.g., 90"
                    min="0"
                    max="100"
                    style={styles.input}
                    className="input"
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.label}>A2A Skills (comma-separated)</label>
                  <input
                    type="text"
                    value={a2aSkills}
                    onChange={(e) => setA2aSkills(e.target.value)}
                    placeholder="e.g., python, javascript"
                    style={styles.input}
                    className="input"
                  />
                </div>
              </>
            )}

            <button
              onClick={handleSearch}
              style={styles.button}
              className="button"
              disabled={loading}
            >
              {loading ? "Searching..." : "Search"}
            </button>
          </div>
        </div>

        {loading && <div style={styles.loadingText}>Loading agents...</div>}
        {error && <div style={styles.errorText}>{error}</div>}

        <div style={styles.discoveryList}>
          {agents.map((agent) => (
            <div key={`${agent.chainId}-${agent.agentId}`} style={styles.discoveryCard}>
              <div style={styles.discoveryCardHeader}>
                <div style={styles.discoveryCardInfo}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                    {agent.image && (
                      <img 
                        src={agent.image} 
                        alt={agent.name}
                        style={{ width: "48px", height: "48px", borderRadius: "8px", objectFit: "cover" }}
                      />
                    )}
                    <div>
                      <div style={{ ...styles.discoveryResourceUrl, fontFamily: "inherit" }}>
                        {agent.name}
                      </div>
                      {agent.description && (
                        <div style={styles.discoveryDescription}>{agent.description}</div>
                      )}
                    </div>
                  </div>
                  {agent.averageScore !== undefined && agent.averageScore !== null && (
                    <div style={{ marginTop: "0.5rem", fontSize: "0.875rem", color: "#00D4A1", fontWeight: 600 }}>
                      ⭐ Rating: {agent.averageScore.toFixed(1)}/100
                    </div>
                  )}
                </div>
                <div style={styles.discoveryCardActions}>
                  {agent.promoted && (
                    <span style={{ ...styles.badge, backgroundColor: "#ffd700", color: "#000" }}>
                      PROMOTED
                    </span>
                  )}
                  <span style={styles.badge}>{agent.active ? "ACTIVE" : "INACTIVE"}</span>
                  <span style={styles.badge}>Chain {agent.chainId}</span>
                  {!agent.promoted && (
                    <button
                      onClick={() => setPromoteModal({ 
                        resourceUrl: agent.agentId, 
                        resourceType: 'agent',
                        agentId: agent.agentId,
                      })}
                      style={styles.buttonSecondary}
                      className="button-secondary"
                      title="Promote this agent"
                    >
                      Promote
                    </button>
                  )}
                  <button
                    onClick={() => toggleExpand(`${agent.chainId}-${agent.agentId}`)}
                    style={styles.iconButton}
                    className="icon-button"
                    title={expandedAgents[`${agent.chainId}-${agent.agentId}`] ? "Collapse" : "Expand"}
                  >
                    {expandedAgents[`${agent.chainId}-${agent.agentId}`] ? '▼' : '▶'}
                  </button>
                </div>
              </div>

              {expandedAgents[`${agent.chainId}-${agent.agentId}`] && (
                <div style={styles.discoveryCardDetails}>
                  <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                    <div>
                      <strong>Agent ID:</strong> <span style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{agent.agentId}</span>
                    </div>
                    <div>
                      <strong>Chain ID:</strong> {agent.chainId}
                    </div>
                    {agent.walletAddress && (
                      <div>
                        <strong>Wallet:</strong> <span style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>{agent.walletAddress}</span>
                      </div>
                    )}
                    {agent.mcpTools && agent.mcpTools.length > 0 && (
                      <div>
                        <strong>MCP Tools:</strong> {agent.mcpTools.join(", ")}
                      </div>
                    )}
                    {agent.a2aSkills && agent.a2aSkills.length > 0 && (
                      <div>
                        <strong>A2A Skills:</strong> {agent.a2aSkills.join(", ")}
                      </div>
                    )}
                    {agent.owners && agent.owners.length > 0 && (
                      <div>
                        <strong>Owners:</strong> {agent.owners.map((owner, i) => (
                          <span key={i} style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>
                            {owner}{i < agent.owners!.length - 1 ? ", " : ""}
                          </span>
                        ))}
                      </div>
                    )}
                    {onAgentSelect && (
                      <button
                        onClick={() => onAgentSelect(agent)}
                        style={styles.button}
                        className="button"
                      >
                        Select Agent
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
          
          {!loading && agents.length === 0 && !error && (
            <div style={{ ...styles.emptyText, textAlign: "center", padding: "2rem" }}>
              No agents found. Try adjusting your search filters.
            </div>
          )}
        </div>

        {(nextCursor || cursor) && (
          <div style={styles.pagination}>
            <div style={styles.paginationInfo}>
              Showing {agents.length} agent{agents.length !== 1 ? "s" : ""}
            </div>
            <div style={styles.paginationControls}>
              <button
                onClick={handlePrevious}
                style={{
                  ...styles.buttonSecondary,
                  ...(cursor === undefined ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                }}
                className="button-secondary"
                disabled={cursor === undefined || loading}
              >
                Previous
              </button>
              <button
                onClick={handleNext}
                style={{
                  ...styles.buttonSecondary,
                  ...(!nextCursor ? { opacity: 0.5, cursor: "not-allowed" } : {}),
                }}
                className="button-secondary"
                disabled={!nextCursor || loading}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
      {promoteModal && (
        <PromoteModal
          isOpen={!!promoteModal}
          onClose={() => setPromoteModal(null)}
          resourceUrl={promoteModal.resourceUrl}
          resourceType={promoteModal.resourceType}
          agentId={promoteModal.agentId}
        />
      )}
    </div>
  );
}

