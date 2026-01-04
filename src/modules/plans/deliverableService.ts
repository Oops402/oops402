/**
 * Deliverable Service
 * Handles deliverable creation and Pinata x402 integration
 */

import { getSupabaseClient } from '../shared/supabase.js';
import { logger } from '../shared/logger.js';
import type { Deliverable, DeliverableInput } from './types.js';
import { getPlan, PlanNotFoundError } from './service.js';
import { uploadFileToPinata, retrievePrivateFile } from './pinataService.js';
import type { PKPAccount } from '../wallet/pkpSigner.js';

const supabase = getSupabaseClient();

/**
 * Create deliverable record
 */
export async function createDeliverable(
  planId: string,
  userId: string,
  deliverableInput: DeliverableInput
): Promise<Deliverable> {
  try {
    // Verify plan exists and user has access
    await getPlan(planId, userId);

    const { data, error } = await supabase
      .from('oops402_plan_deliverables')
      .insert({
        plan_id: planId,
        type: deliverableInput.type,
        title: deliverableInput.title,
        storage: deliverableInput.storage,
        evidence: deliverableInput.evidence || null,
        checksum: deliverableInput.checksum || null,
        metadata: deliverableInput.metadata || {},
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to create deliverable', error as Error, { planId, userId });
      throw new Error(`Failed to create deliverable: ${error.message}`);
    }

    return mapDbDeliverableToDeliverable(data);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error creating deliverable', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Get deliverables for a plan
 */
export async function getDeliverables(planId: string, userId: string): Promise<Deliverable[]> {
  try {
    // Verify plan exists and user has access
    await getPlan(planId, userId);

    const { data, error } = await supabase
      .from('oops402_plan_deliverables')
      .select('*')
      .eq('plan_id', planId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('Failed to get deliverables', error as Error, { planId, userId });
      throw new Error(`Failed to get deliverables: ${error.message}`);
    }

    return (data || []).map(mapDbDeliverableToDeliverable);
  } catch (error) {
    if (error instanceof PlanNotFoundError) {
      throw error;
    }
    logger.error('Error getting deliverables', error as Error, { planId, userId });
    throw error;
  }
}

/**
 * Upload file to Pinata and create deliverable
 */
export async function uploadDeliverableToPinata(
  planId: string,
  userId: string,
  file: File | Buffer | Uint8Array,
  fileSize: number,
  type: string,
  title: string,
  network: 'public' | 'private',
  pkpAccount: PKPAccount,
  evidence?: DeliverableInput['evidence'],
  metadata?: Record<string, unknown>
): Promise<Deliverable> {
  try {
    // Upload to Pinata
    const { cid, gatewayUrl } = await uploadFileToPinata(file, fileSize, network, pkpAccount);

    // Create deliverable record
    const deliverableInput: DeliverableInput = {
      type,
      title,
      storage: {
        kind: 'ipfs',
        cid,
        gateway_url: gatewayUrl || null,
      },
      evidence,
      metadata,
    };

    return await createDeliverable(planId, userId, deliverableInput);
  } catch (error) {
    logger.error('Error uploading deliverable to Pinata', error as Error, {
      planId,
      userId,
      type,
    });
    throw error;
  }
}

/**
 * Retrieve private deliverable file
 */
export async function retrieveDeliverableFile(
  planId: string,
  userId: string,
  deliverableId: string,
  pkpAccount: PKPAccount
): Promise<{ url: string }> {
  try {
    // Verify plan exists and user has access
    await getPlan(planId, userId);

    // Get deliverable
    const { data, error } = await supabase
      .from('oops402_plan_deliverables')
      .select('storage')
      .eq('id', deliverableId)
      .eq('plan_id', planId)
      .single();

    if (error) {
      logger.error('Deliverable not found', error as Error, { planId, deliverableId });
      throw new Error(`Deliverable not found: ${error.message}`);
    }

    const cid = data.storage.cid;
    if (!cid) {
      throw new Error('Deliverable does not have a CID');
    }

    // Retrieve from Pinata
    return await retrievePrivateFile(cid, pkpAccount);
  } catch (error) {
    logger.error('Error retrieving deliverable file', error as Error, {
      planId,
      userId,
      deliverableId,
    });
    throw error;
  }
}

/**
 * Map database deliverable to Deliverable type
 */
function mapDbDeliverableToDeliverable(dbDeliverable: any): Deliverable {
  return {
    id: dbDeliverable.id,
    plan_id: dbDeliverable.plan_id,
    type: dbDeliverable.type,
    title: dbDeliverable.title,
    storage: dbDeliverable.storage,
    evidence: dbDeliverable.evidence || undefined,
    checksum: dbDeliverable.checksum || undefined,
    metadata: dbDeliverable.metadata || {},
    created_at: dbDeliverable.created_at,
  };
}
