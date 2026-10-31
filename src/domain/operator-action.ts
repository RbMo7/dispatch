/** ADR-0057: which bearer token made a request. */
export type TokenKind = 'auth' | 'operator';

export type OperatorActionKind = 'cancel';

/** Who did an operator action, as far as a shared-secret engine can say: the token, and the reason they gave. */
export type OperatorActor = { tokenKind: TokenKind; reason: string | null };

/** ADR-0057's audit record: one per cancel, release and Flag Rule write. */
export type OperatorAction = OperatorActor & {
  id: string;
  at: Date;
  action: OperatorActionKind;
  /** The Dispatch or Flag Rule acted on. */
  targetId: string;
};
