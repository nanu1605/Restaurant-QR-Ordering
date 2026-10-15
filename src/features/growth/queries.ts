import 'server-only';

import { cache } from 'react';

import { createClient } from '@/lib/supabase/server';

import { parseFunnel, parseUpgrades } from './funnel';
import { parseLead, parseLeadList, parseUnfinishedSignups, type LeadFilters } from './leads';

/** The leads pipeline (docs/DECISIONS.md SA-55): a page of the table, or the board. */
export async function listLeads(filters: LeadFilters) {
  const { view, ...rest } = filters;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_list_leads', {
    p_filters: view === 'board' ? { ...rest, page: undefined, board: true } : rest,
  });
  if (error) throw new Error(`Could not load the leads: ${error.message}`);
  return parseLeadList(data);
}

/** One lead, or null when there is none. The page's title and the page both ask. */
export const getLead = cache(async (leadId: string) => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_get_lead', { p_lead_id: leadId });
  if (error) {
    if (error.message === 'NOT_FOUND' || error.code === '22P02') return null;
    throw new Error(`Could not load the lead: ${error.message}`);
  }
  return parseLead(data);
});

export async function getUnfinishedSignups() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_unfinished_signups');
  if (error) throw new Error(`Could not load the unfinished signups: ${error.message}`);
  return parseUnfinishedSignups(data);
}

export async function getFunnel(from: string, to: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_funnel', { p_from: from, p_to: to });
  if (error) throw new Error(`Could not load the funnel: ${error.message}`);
  return parseFunnel(data);
}

export async function getUpgradeOpportunities() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('platform_upgrade_opportunities');
  if (error) throw new Error(`Could not load the upgrade opportunities: ${error.message}`);
  return parseUpgrades(data);
}
