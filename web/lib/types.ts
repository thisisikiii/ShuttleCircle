export type Role = "member" | "host" | "admin" | "superadmin";
export type RequestStatus = "pending" | "awaiting_payment" | "confirmed" | "rejected" | "cancelled" | "expired";
export type MatchStatus = "scheduled" | "ongoing" | "completed" | "cancelled";
export type MatchType = "beginner_friendly" | "intermediate";
export type ExpenseCategory = "drinking_water" | "shuttlecock" | "other";

export type Member = {
  kind: "member";
  id: string;
  email: string;
  full_name: string;
  whatsapp_number: string | null;
  role: Role;
  email_verified: boolean;
  wallet_balance_idr: number;
  membership_months: string[];
  rewards: { id: string; expires_at: string }[];
  unread_notifications: number;
};
export type Me = Member | { kind: "guest"; nickname: string };

export type Health = { status: string; features: { gateway: boolean; google: boolean; email: boolean; whatsapp: boolean } };

export type Match = {
  id: string;
  title: string;
  starts_at: string;
  duration_hours: number;
  location_name: string;
  location_maps_url: string;
  capacity: number;
  seats_taken: number;
  match_type: MatchType;
  racket_provided: boolean;
  shuttlecock_provided: boolean;
  equipment_notes: string | null;
  price_idr: number;
  court_cost_per_hour_idr?: number;
  status: MatchStatus;
  host: { id: string; full_name: string };
  my_request: { id: string; status: RequestStatus; hold_expires_at: string | null } | null;
};

export type RosterEntry = { join_request_id: string; name: string; games_played: number | null };

export type JoinRequest = {
  id: string;
  match_id: string;
  match_title: string;
  match_starts_at: string;
  price_idr: number;
  player: { kind: "guest" | "member"; name: string; user_id: string | null };
  status: RequestStatus;
  payment_method: "membership" | "reward" | "wallet" | "gateway" | null;
  hold_expires_at: string | null;
  conversion_required: boolean;
  games_played: number | null;
  note: string | null;
  created_at: string;
};

export type GenderMode = "any" | "mixed" | "men" | "women";
export type LevelMode = "off" | "balanced" | "mixed";
export type RotationPlayer = {
  join_request_id: string;
  name: string;
  state: "absent" | "waiting" | "playing" | "resting" | "left";
  gender: "M" | "F" | null;
  level: 1 | 2 | 3 | null;
  arrived_at: string | null;
  wait_since: string | null;
  games: number;
  effective_games: number;
  minutes_played: number;
  queued: boolean;
  queue_position: number | null;
};
export type RotationGame = {
  id: string;
  court: number;
  status: "next" | "playing" | "done";
  team_a: string[];
  team_b: string[];
  score_a: number | null;
  score_b: number | null;
  started_at: string | null;
  ended_at: string | null;
};
export type Rotation = {
  singles: boolean;
  courts: { court: number; gender_mode: GenderMode; level_mode: LevelMode }[];
  players: RotationPlayer[];
  games: RotationGame[];
};

export type MatchDetail = Match &{ roster?: RosterEntry[]; requests?: JoinRequest[]; can_manage?: boolean };

export type Payment = { id: string; amount_idr: number; redirect_url: string; expires_at: string };
export type PayResult = { status: "confirmed" } | { status: "awaiting_payment"; payment: Payment };

export type LedgerEntry = {
  id: string;
  amount_idr: number;
  txn_type: "topup" | "manual_credit" | "match_payment" | "membership" | "donation" | "refund" | "adjustment";
  join_request_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type HistoryItem = Match & { players: { name: string; games_played: number | null }[]; media_count: number };
export type Media = { id: string; kind: "photo" | "video"; size_bytes: number; created_at: string };
export type Notice = {
  id: string;
  kind: string;
  payload: { title: string; body: string };
  read_at: string | null;
  created_at: string;
};

export type User = {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: "active" | "suspended";
  wallet_balance_idr: number;
};
export type FinanceSummary = {
  cash_in_idr: number;
  fee_income_idr: number;
  membership_income_idr: number;
  donation_idr: number;
  court_cost_idr: number;
  expenses: Record<ExpenseCategory, number>;
  member_balance_idr: number;
};
export type Expense = {
  id: string;
  category: ExpenseCategory;
  amount_idr: number;
  spent_on: string;
  note: string | null;
};
export type Settings = { reward_enabled: boolean; membership_price_idr: number | null; min_topup_idr: number };
