package federation

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/l33tdawg/sage/internal/store"
)

// AgentExposureCandidate contains only operator-facing directory metadata.
// Eligibility comes from the same consensus checks used when saving a selection;
// a locally active registry row alone is not enough to offer an agent here.
type AgentExposureCandidate struct {
	AgentID          string `json:"agent_id"`
	DisplayName      string `json:"display_name"`
	RegisteredName   string `json:"registered_name,omitempty"`
	Provider         string `json:"provider,omitempty"`
	MessagingBlocked bool   `json:"messaging_blocked,omitempty"`
}

func (m *Manager) ListFederatedAgentExposureAgents(ctx context.Context, remoteChainID string) ([]AgentExposureCandidate, error) {
	ss := m.syncStore()
	if ss == nil || m.badger == nil {
		return nil, errors.New("agent discovery roster requires local consensus and SQLite state")
	}
	policyUnlock := ss.LockSyncPolicyRead()
	defer policyUnlock()
	ownerUnlock := m.badger.LockDomainOwnershipRead()
	defer ownerUnlock()
	contactUnlock := ss.LockAgentContactRead()
	defer contactUnlock()
	policy, err := m.GetPeerRBACPolicy(ctx, remoteChainID)
	if err != nil || policy == nil {
		return nil, errors.New("agent discovery roster requires an active peer policy binding")
	}
	agents, err := ss.ListAgents(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]AgentExposureCandidate, 0, len(agents))
	for _, agent := range agents {
		if agent == nil || agent.Status != "active" || agent.RemovedAt != nil || !isCanonicalAgentID(agent.AgentID) {
			continue
		}
		eligible, eligibilityErr := m.localFederatedGuestAgentEligible(agent.AgentID)
		if eligibilityErr != nil {
			return nil, fmt.Errorf("resolve agent discovery eligibility: %w", eligibilityErr)
		}
		if eligible {
			onChain, policyErr := m.badger.GetRegisteredAgent(agent.AgentID)
			if policyErr != nil || onChain == nil {
				return nil, errors.New("agent messaging policy is unavailable")
			}
			result = append(result, AgentExposureCandidate{
				AgentID: agent.AgentID, DisplayName: pipeContactAgentDisplayName(agent),
				RegisteredName: agent.RegisteredName, Provider: agent.Provider,
				MessagingBlocked: onChain.Capabilities.Has(store.AgentCapabilityDenyFederatedPipe),
			})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].AgentID < result[j].AgentID })
	return result, nil
}

// agentExposureBindingFromPolicy freezes the exact live trust generation, the
// same four fields every other connection-scoped snapshot binds to.
func agentExposureBindingFromPolicy(policy *store.PeerRBACPolicy) store.FederatedAgentExposureBinding {
	if policy == nil {
		return store.FederatedAgentExposureBinding{}
	}
	return store.FederatedAgentExposureBinding{
		RemoteChainID: policy.RemoteChainID,
		PeerAgentID:   policy.PeerAgentID,
		PolicyEpoch:   policy.PolicyEpoch,
		RemoteCAPin:   policy.RemoteCAPin,
	}
}

// GetFederatedAgentExposure returns the connection's agent-discovery policy.
// An unconfigured connection reports the documented default (all eligible
// ordinary agents are discoverable), so nothing changes for existing links.
func (m *Manager) GetFederatedAgentExposure(
	ctx context.Context, remoteChainID string,
) (*store.FederatedAgentExposure, error) {
	policy, err := m.GetPeerRBACPolicy(ctx, remoteChainID)
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, errors.New("agent discovery policy requires an active peer policy binding")
	}
	ss := m.syncStore()
	if ss == nil {
		return nil, errors.New("agent discovery policy requires the SQLite store backend")
	}
	return ss.GetFederatedAgentExposure(ctx, agentExposureBindingFromPolicy(policy))
}

// SetFederatedAgentExposure replaces the connection's discovery policy. The
// listed agents must each be a currently eligible ordinary local agent, so an
// operator cannot allow-list a Root identity, a retired agent, or an id that
// the discovery projection would refuse anyway. Discovery only: this call
// never grants memory Read and never authorizes delivery.
func (m *Manager) SetFederatedAgentExposure(
	ctx context.Context, remoteChainID, mode string, agentIDs []string, expectedRevision int64,
) (*store.FederatedAgentExposure, error) {
	switch mode {
	case store.FederatedAgentExposureModeAll, store.FederatedAgentExposureModeSelected,
		store.FederatedAgentExposureModeNone:
	default:
		return nil, errors.New("agent discovery mode must be all, selected, or none")
	}
	policy, err := m.GetPeerRBACPolicy(ctx, remoteChainID)
	if err != nil {
		return nil, err
	}
	if policy == nil {
		return nil, errors.New("agent discovery policy requires an active peer policy binding")
	}
	ss := m.syncStore()
	if ss == nil {
		return nil, errors.New("agent discovery policy requires the SQLite store backend")
	}
	canonical := make([]string, 0, len(agentIDs))
	seen := make(map[string]struct{}, len(agentIDs))
	for _, agentID := range agentIDs {
		trimmed := strings.ToLower(strings.TrimSpace(agentID))
		if !isCanonicalAgentID(trimmed) {
			return nil, fmt.Errorf("agent discovery selection %q is not a canonical agent id", agentID)
		}
		if _, duplicate := seen[trimmed]; duplicate {
			continue
		}
		eligible, eligibilityErr := m.localFederatedGuestAgentEligible(trimmed)
		if eligibilityErr != nil {
			return nil, eligibilityErr
		}
		if !eligible {
			return nil, fmt.Errorf("agent %s is not an active ordinary local agent", trimmed)
		}
		seen[trimmed] = struct{}{}
		canonical = append(canonical, trimmed)
	}
	if mode != store.FederatedAgentExposureModeSelected {
		canonical = nil
	}
	return ss.SetBoundFederatedAgentExposure(
		ctx, agentExposureBindingFromPolicy(policy), mode, canonical, expectedRevision)
}

// agentExposureGate resolves the connection's discovery policy once per
// projection build and returns a per-agent predicate. It exists so a bounded
// contact page never issues a SQLite read per candidate agent.
//
// Every failure is propagated rather than defaulted: an unreadable or
// mismatched exposure policy must not be mistaken for the permissive default.
func (m *Manager) agentExposureGate(
	ctx context.Context, peer *peerIdentity, policy *store.PeerRBACPolicy,
) (func(string) (bool, error), error) {
	if peer == nil || policy == nil || m.syncStore() == nil {
		return nil, nil
	}
	exposure, err := m.syncStore().GetFederatedAgentExposure(ctx, agentExposureBindingFromPolicy(policy))
	if err != nil {
		return nil, fmt.Errorf("resolve federated agent discovery policy: %w", err)
	}
	if exposure == nil || !exposure.Configured {
		return nil, nil
	}
	switch exposure.Mode {
	case store.FederatedAgentExposureModeAll:
		return nil, nil
	case store.FederatedAgentExposureModeNone:
		return func(string) (bool, error) { return false, nil }, nil
	case store.FederatedAgentExposureModeSelected:
		allowed := make(map[string]struct{}, len(exposure.AgentIDs))
		for _, agentID := range exposure.AgentIDs {
			allowed[strings.ToLower(agentID)] = struct{}{}
		}
		return func(agentID string) (bool, error) {
			_, ok := allowed[strings.ToLower(agentID)]
			return ok, nil
		}, nil
	default:
		return nil, errors.New("federated agent discovery policy mode is invalid")
	}
}
