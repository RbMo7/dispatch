/** ADR-0057: which bearer token made a request. */
export type TokenKind = 'auth' | 'operator';

export type OperatorActionKind =
  | 'cancel'
  | 'release'
  | 'flag_rule_create'
  | 'flag_rule_update'
  | 'flag_rule_delete'
  | 'asset_add'
  | 'asset_disable'
  | 'asset_enable'
  | 'contract_add'
  | 'contract_disable'
  | 'contract_enable';

/** Who did an operator action, as far as a shared-secret engine can say: the token, and the reason they gave. */
export type OperatorActor = { tokenKind: TokenKind; reason: string | null };

/** ADR-0057's audit record: one per cancel, release, Flag Rule write, Known Asset write (ADR-0061) and contract registry write (ADR-0063). */
export type OperatorAction = OperatorActor & {
  id: string;
  at: Date;
  action: OperatorActionKind;
  /** The Dispatch, Flag Rule, Known Asset or registered contract acted on. */
  targetId: string;
};
