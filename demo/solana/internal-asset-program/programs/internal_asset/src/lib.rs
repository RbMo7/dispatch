use anchor_lang::prelude::*;

declare_id!("EcqsVLKPa1uuNG1Rs6tj2t8aGj1bAYgEwJszGHmpbo7x");

/// A minimal internal asset ledger: balances live entirely in this
/// program's own PDA-owned accounts, never touching SPL Token — a
/// deliberately custom, novel-to-any-caller asset, to exercise a
/// generic engine's "opaque contract call" path against something it
/// has never seen before.
#[program]
pub mod internal_asset {
    use super::*;

    /// Creates the PDA balance account for `owner` and credits it with
    /// `initial_balance` units — the internal-asset equivalent of a mint.
    pub fn initialize_asset(ctx: Context<InitializeAsset>, initial_balance: u64) -> Result<()> {
        let asset = &mut ctx.accounts.asset_account;
        asset.owner = ctx.accounts.owner.key();
        asset.balance = initial_balance;
        Ok(())
    }

    /// Moves `amount` units from `owner`'s balance to `to_owner`'s —
    /// requires `owner`'s signature, never `to_owner`'s.
    pub fn transfer_asset(ctx: Context<TransferAsset>, amount: u64) -> Result<()> {
        require!(ctx.accounts.from.balance >= amount, AssetError::InsufficientBalance);
        ctx.accounts.from.balance -= amount;
        ctx.accounts.to.balance += amount;
        Ok(())
    }
}

#[account]
pub struct AssetAccount {
    pub owner: Pubkey,
    pub balance: u64,
}

impl AssetAccount {
    pub const SPACE: usize = 8 + 32 + 8;
}

#[derive(Accounts)]
pub struct InitializeAsset<'info> {
    #[account(
        init,
        payer = payer,
        space = AssetAccount::SPACE,
        seeds = [b"asset", owner.key().as_ref()],
        bump,
    )]
    pub asset_account: Account<'info, AssetAccount>,
    /// CHECK: only used to derive the PDA and record ownership — the
    /// owner's own signature isn't required to be minted a balance,
    /// only to later spend from it (see `TransferAsset`).
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TransferAsset<'info> {
    #[account(
        mut,
        seeds = [b"asset", owner.key().as_ref()],
        bump,
        has_one = owner,
    )]
    pub from: Account<'info, AssetAccount>,
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [b"asset", to_owner.key().as_ref()],
        bump,
    )]
    pub to: Account<'info, AssetAccount>,
    /// CHECK: only used to derive and validate `to`'s PDA seeds.
    pub to_owner: UncheckedAccount<'info>,
}

#[error_code]
pub enum AssetError {
    #[msg("insufficient internal asset balance")]
    InsufficientBalance,
}
