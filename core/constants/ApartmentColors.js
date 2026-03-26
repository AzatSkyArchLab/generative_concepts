/**
 * ApartmentColors — single source of truth for apartment type colors.
 * Used by section-gen, MeshBuilder, FloorPlanReport.
 */

export var TYPE_COLORS = {
  apartment: '#dce8f0',
  commercial: '#ffb74d',
  corridor: '#c8c8c8',
  llu: '#4f81bd'
};

export var APT_COLORS = {
  '1K':     { living: '#ade8f4', wet: '#7ab8c8' },
  '2K':     { living: '#90ee90', wet: '#64a664' },
  '3K':     { living: '#ffdab9', wet: '#c4987a' },
  '4K':     { living: '#dda0dd', wet: '#a870a8' },
  'orphan': { living: '#e8e8e8', wet: '#b0b0b0' }
};

/**
 * Report variant with slightly different wet shades.
 * FloorPlanReport uses its own palette for print clarity.
 */
export var APT_COLORS_REPORT = {
  '1K':     { living: '#ade8f4', wet: '#6bb8d0' },
  '2K':     { living: '#90ee90', wet: '#5cb85c' },
  '3K':     { living: '#ffdab9', wet: '#e0a870' },
  '4K':     { living: '#dda0dd', wet: '#b070b0' },
  'orphan': { living: '#e0e0e0', wet: '#aaaaaa' }
};
