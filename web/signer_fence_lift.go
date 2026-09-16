package web

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/l33tdawg/sage/internal/auth"
	"github.com/l33tdawg/sage/internal/tx"
)

// handleSignerFenceLift is the operator's recovery path for a fence that
// reconciliation cannot resolve by itself.
//
// It exists because the fence's own rule — never lift without PROOF — has one
// shape it cannot handle alone: a submission whose fate was never observed and
// whose signed bytes did not survive the process that sent it. Before durable
// intent that fence simply vanished on restart and the transaction was lost
// quietly; now it survives, which means the node comes back refusing to sign a
// key that only a proven fate can release. Without this endpoint that refusal
// would have no exit at all.
//
// THE PROOF IS READ FROM THIS NODE, NOT SUPPLIED BY THE CALLER. The caller names
// a signer; the handler reads the committed nonce floor from the same store the
// allocator seeds from and looks the recorded hash up on the node's own RPC.
// A caller cannot assert a fate, and a response that reports "unproven" is the
// normal, non-exceptional outcome — it means the evidence still is not there.
func (h *DashboardHandler) handleSignerFenceLift(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Signer string `json:"signer"`
		Reason string `json:"reason"`
	}
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSONResp(w, http.StatusBadRequest, map[string]any{
			"error": "invalid request body", "detail": err.Error(),
		})
		return
	}
	signer := strings.TrimSpace(request.Signer)
	if signer == "" {
		writeJSONResp(w, http.StatusBadRequest, map[string]any{
			"error": "signer is required (the fence's signer public key, hex)",
		})
		return
	}

	// Match the live fence by full key or by the prefix the status surface
	// prints, so an operator can copy either one out of /health.
	held := tx.FencedSigners()
	var target *tx.FencedSigner
	for i := range held {
		if strings.EqualFold(held[i].SignerPubKeyHex, signer) ||
			strings.EqualFold(held[i].SignerPubKeyPrefix, signer) {
			target = &held[i]
			break
		}
	}
	if target == nil {
		writeJSONResp(w, http.StatusNotFound, map[string]any{
			"error": "no signer fence is held for that signer",
			"held":  len(held),
		})
		return
	}

	// The nonce floor is the same source SetNonceFloorFunc uses to re-seed the
	// allocator, so supersession is judged against what the chain actually
	// committed rather than against anything a caller reported.
	var nonceFloor func(ed25519.PublicKey) (uint64, bool)
	if h.BadgerStore != nil {
		nonceFloor = func(pub ed25519.PublicKey) (uint64, bool) {
			n, err := h.BadgerStore.GetNonce(auth.PublicKeyToAgentID(pub))
			if err != nil || n == 0 {
				return 0, false
			}
			return n, true
		}
	}

	proof, err := tx.ProveFenceLiftFromChain(r.Context(), h.CometBFTRPC, nonceFloor, *target)
	if err != nil {
		var unproven *tx.FenceLiftUnprovenError
		if errors.As(err, &unproven) {
			writeJSONResp(w, http.StatusConflict, map[string]any{
				"error":  "no proof of this transaction's fate yet",
				"detail": unproven.Reason,
				"signer": target.SignerPubKeyPrefix,
			})
			return
		}
		writeJSONResp(w, http.StatusBadGateway, map[string]any{
			"error":  "the fate of this transaction could not be read",
			"detail": err.Error(),
		})
		return
	}
	if reason := strings.TrimSpace(request.Reason); reason != "" {
		proof.Detail = proof.Detail + " | operator note: " + reason
	}
	if err := tx.LiftFenceWithProof(r.Context(), target.SignerPubKeyHex, proof); err != nil {
		writeJSONResp(w, http.StatusConflict, map[string]any{
			"error":  "the fence refused the proof",
			"detail": err.Error(),
		})
		return
	}

	writeJSONResp(w, http.StatusOK, map[string]any{
		"lifted": true,
		"signer": target.SignerPubKeyPrefix,
		"proof": map[string]any{
			"kind":            proof.Kind,
			"detail":          proof.Detail,
			"committed_nonce": proof.CommittedNonce,
		},
		"note": "the fence is lifted and its durable intent retired; a superseded lift means the fenced " +
			"transaction can never commit and its payload is permanently lost",
	})
}
