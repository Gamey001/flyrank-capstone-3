import { createHash } from 'node:crypto';
import type { Widget } from '../domain/models.js';
import { AppError } from '../lib/errors.js';
import { publicWidgetId } from '../lib/ids.js';
import {
  widgetsRepository,
  type CreateWidgetInput,
  type UpdateWidgetInput,
} from '../repositories/widgets.repository.js';
import { embedService, type EmbedSnippet } from './embed.service.js';

export type CreateWidgetRequest = Omit<CreateWidgetInput, 'tenantId' | 'publicId'>;

// A projection, not the row: this is downloaded by every visitor to a customer
// site, so tenantId, webhookUrl and notifyEmail must never appear in it.
export interface PublicWidgetConfig {
  id: string;
  type: Widget['type'];
  title: string;
  description: string | null;
  buttonText: string;
  successMessage: string;
  fields: Widget['fields'];
  display: Widget['display'];
  honeypotField: string;
  revision: number;
}

export interface WidgetWithEmbed extends Widget {
  embed: EmbedSnippet;
}

const withEmbed = (widget: Widget): WidgetWithEmbed => ({
  ...widget,
  embed: embedService.forWidget(widget),
});

export const widgetsService = {
  async create(tenantId: string, input: CreateWidgetRequest): Promise<WidgetWithEmbed> {
    const widget = await widgetsRepository.create({
      ...input,
      tenantId,
      publicId: publicWidgetId(),
    });
    return withEmbed(widget);
  },

  async list(
    tenantId: string,
    options: { limit: number; offset: number },
  ): Promise<{ items: WidgetWithEmbed[]; total: number }> {
    const { items, total } = await widgetsRepository.listForTenant(tenantId, options);
    return { items: items.map(withEmbed), total };
  },

  async get(tenantId: string, widgetId: string): Promise<WidgetWithEmbed> {
    const widget = await widgetsRepository.findByIdForTenant(widgetId, tenantId);
    // 404 rather than 403 for another tenant's widget: a 403 confirms the id
    // exists. Same reasoning throughout this service.
    if (!widget) throw AppError.notFound('Widget not found');
    return withEmbed(widget);
  },

  async update(tenantId: string, widgetId: string, patch: UpdateWidgetInput): Promise<WidgetWithEmbed> {
    const widget = await widgetsRepository.update(widgetId, tenantId, patch);
    if (!widget) throw AppError.notFound('Widget not found');
    return withEmbed(widget);
  },

  async remove(tenantId: string, widgetId: string): Promise<void> {
    const deleted = await widgetsRepository.softDelete(widgetId, tenantId);
    if (!deleted) throw AppError.notFound('Widget not found');
  },

  async getEmbed(tenantId: string, widgetId: string): Promise<EmbedSnippet> {
    const widget = await this.get(tenantId, widgetId);
    return widget.embed;
  },

  async publicConfig(publicId: string): Promise<{ config: PublicWidgetConfig; etag: string }> {
    const widget = await widgetsRepository.findActiveByPublicId(publicId);
    if (!widget) throw AppError.notFound('Widget not found or inactive');

    const config: PublicWidgetConfig = {
      id: widget.publicId,
      type: widget.type,
      title: widget.title,
      description: widget.description,
      buttonText: widget.buttonText,
      successMessage: widget.successMessage,
      fields: widget.fields,
      display: widget.display,
      honeypotField: widget.honeypotField,
      revision: widget.revision,
    };

    // revision and updated_at together cover every way the config can change.
    const etag = `"${createHash('sha1')
      .update(`${widget.publicId}:${widget.revision}:${widget.updatedAt.toISOString()}`)
      .digest('hex')
      .slice(0, 16)}"`;

    return { config, etag };
  },
};
