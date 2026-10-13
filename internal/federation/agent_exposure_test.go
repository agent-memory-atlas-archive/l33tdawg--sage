package federation

import (
	"context"
	"testing"

	"github.com/l33tdawg/sage/internal/store"
	"github.com/stretchr/testify/require"
)

func TestAgentExposureRosterUsesConsensusEligibilityIndependentOfVisibility(t *testing.T) {
	ctx := context.Background()
	m, ss, bs := newDrainTestManager(t)
	ensurePipeContactAppV23(t, m, bs)
	peerID := newPeerOperatorID(t)
	configurePeerRBACConnection(t, m, ss, bs, "chain-peer", peerID, "host", nil, 4)
	active, blocked, inactive, stale := newPeerOperatorID(t), newPeerOperatorID(t), newPeerOperatorID(t), newPeerOperatorID(t)
	seedPipeContactOrdinaryAgent(t, m, ss, bs, active, "active", "active", 0, 10)
	seedPipeContactOrdinaryAgent(t, m, ss, bs, blocked, "messaging-blocked", "active", store.AgentCapabilityDenyFederatedPipe, 20)
	seedPipeContactOrdinaryAgent(t, m, ss, bs, inactive, "inactive", "inactive", 0, 30)
	// This is precisely the mismatch in the old picker: a locally active row is
	// not proof of an active consensus enrollment, and cannot enter a selection.
	require.NoError(t, ss.CreateAgent(ctx, &store.AgentEntry{AgentID: stale, Name: "stale registry", Status: "active"}))
	root, err := bs.GetAppV23Root()
	require.NoError(t, err)
	require.NoError(t, ss.CreateAgent(ctx, &store.AgentEntry{AgentID: root.CredentialID, Name: "Root", Status: "active"}))
	_, err = m.SetFederatedAgentExposure(ctx, "chain-peer", store.FederatedAgentExposureModeNone, nil, 0)
	require.NoError(t, err)
	roster, err := m.ListFederatedAgentExposureAgents(ctx, "chain-peer")
	require.NoError(t, err)
	ids := make([]string, 0, len(roster))
	for _, agent := range roster {
		ids = append(ids, agent.AgentID)
		require.Equal(t, agent.AgentID == blocked, agent.MessagingBlocked)
	}
	require.ElementsMatch(t, []string{active, blocked}, ids, "hidden agents remain selectable; messaging restrictions do not remove discovery choices")
	// The exact roster accepted by the UI must also be accepted by the saver.
	exposure, err := m.SetFederatedAgentExposure(ctx, "chain-peer", store.FederatedAgentExposureModeSelected, ids, 1)
	require.NoError(t, err)
	require.ElementsMatch(t, ids, exposure.AgentIDs)
	_, err = m.ListFederatedAgentExposureAgents(ctx, "unknown-chain")
	require.Error(t, err)
}
