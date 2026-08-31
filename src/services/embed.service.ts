import { env } from '../config/env.js';
import type { Widget } from '../domain/models.js';
import { widgetAsset } from './widget-asset.service.js';

export interface EmbedSnippet {
  version: string;
  scriptUrl: string;
  configUrl: string;
  snippet: string;
  snippetWithPlaceholder: string;
}

// Generated on read rather than stored, so an existing widget starts serving a
// new bundle version the moment one is released.
export const embedService = {
  forWidget(widget: Pick<Widget, 'publicId'>): EmbedSnippet {
    const base = env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    const scriptUrl = `${base}${widgetAsset.versionedPath}?id=${widget.publicId}`;
    const configUrl = `${base}/api/public/widgets/${widget.publicId}/config`;

    return {
      version: widgetAsset.version,
      scriptUrl,
      configUrl,
      snippet: `<script src="${scriptUrl}" async></script>`,
      snippetWithPlaceholder: [
        `<div data-flyrank-widget="${widget.publicId}"></div>`,
        `<script src="${scriptUrl}" async></script>`,
      ].join('\n'),
    };
  },
};
