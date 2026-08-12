import { admin } from '@/lib/supabase/admin';
import type { Config } from '@/lib/types/db';

export async function getConfig(): Promise<Config> {
  const { data, error } = await admin()
    .from('config')
    .select('*')
    .eq('id', true)
    .single();
  if (error) throw error;
  return data as Config;
}

export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  const { data, error } = await admin()
    .from('config')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', true)
    .select('*')
    .single();
  if (error) throw error;
  return data as Config;
}
