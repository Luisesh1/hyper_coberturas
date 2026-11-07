// Un activo tiene una categoría principal y puede estar además en cestas temáticas
// (`extraCategories`, p. ej. NVIDIA: Top 100 y también IA). Úsalo en todo filtro por categoría.
export function inAssetCategory(asset, category) {
  if (!asset) return false;
  if (category === 'all') return true;
  return asset.category === category
    || (Array.isArray(asset.extraCategories) && asset.extraCategories.includes(category));
}
