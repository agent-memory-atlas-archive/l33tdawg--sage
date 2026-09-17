package abci

import "fmt"

// postAppV28Fork is the strict H+1 boundary for the public-memory commitment
// and the consensus-side co-commit tombstone rule. The activation block at H
// still runs under app-v27 rules; both v28 rules apply only from H+1.
func (app *SageApp) postAppV28Fork(height int64) bool {
	return app.appV28AppliedHeight > 0 && height > app.appV28AppliedHeight
}

// refreshAppV28Fork populates appV28AppliedHeight from the persisted upgrade
// audit trail. Called from both constructors on boot, so a node restarting on
// a post-app-v28 chain re-derives the activation height before it serves a
// block. Returns nil-record on every chain that has not activated app-v28, so
// the gate stays dormant and replay is unaffected.
func (app *SageApp) refreshAppV28Fork() error {
	app.appV28AppliedHeight = 0
	rec, err := app.badgerStore.GetAppliedUpgrade(appV28UpgradeName)
	if err != nil {
		return fmt.Errorf("read applied %s record: %w", appV28UpgradeName, err)
	}
	if rec == nil {
		return nil
	}
	if rec.Name != appV28UpgradeName || rec.TargetAppVersion != 28 || rec.AppliedHeight <= 0 {
		return fmt.Errorf("invalid applied %s record", appV28UpgradeName)
	}
	if app.state == nil {
		return fmt.Errorf("applied %s record cannot be checked without app state", appV28UpgradeName)
	}
	if app.state.Height < rec.AppliedHeight-1 {
		return fmt.Errorf(
			"applied %s height %d is ahead of persisted app height %d",
			appV28UpgradeName, rec.AppliedHeight, app.state.Height,
		)
	}
	app.appV28AppliedHeight = rec.AppliedHeight
	return nil
}

func (app *SageApp) validateAppV28Predecessor() (int64, error) {
	if app.appV27AppliedHeight <= 0 {
		return 0, fmt.Errorf("missing active %s predecessor", appV27UpgradeName)
	}
	rec, err := app.badgerStore.GetAppliedUpgrade(appV27UpgradeName)
	if err != nil {
		return 0, fmt.Errorf("read applied %s predecessor: %w", appV27UpgradeName, err)
	}
	if rec == nil || rec.Name != appV27UpgradeName ||
		rec.TargetAppVersion != 27 || rec.AppliedHeight != app.appV27AppliedHeight {
		return 0, fmt.Errorf("invalid active %s predecessor", appV27UpgradeName)
	}
	return rec.AppliedHeight, nil
}

func (app *SageApp) validateAppV28Prerequisite() error {
	if app.appV28AppliedHeight <= 0 {
		return nil
	}
	predecessorHeight, err := app.validateAppV28Predecessor()
	if err != nil {
		return fmt.Errorf("applied %s has invalid predecessor: %w", appV28UpgradeName, err)
	}
	if app.appV28AppliedHeight <= predecessorHeight {
		return fmt.Errorf(
			"applied %s height %d must be after applied %s predecessor height %d",
			appV28UpgradeName, app.appV28AppliedHeight,
			appV27UpgradeName, predecessorHeight,
		)
	}
	return nil
}
