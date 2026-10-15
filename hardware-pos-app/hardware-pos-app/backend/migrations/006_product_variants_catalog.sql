-- Per-variant SKU and product-card variant catalog support.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS variant_sku text;

-- Preserve the existing product SKU for its first variant; assign deterministic suffixes
-- to additional variants that previously shared the product-level SKU.
WITH ranked AS (
  SELECT v.id, p.sku, row_number() OVER (PARTITION BY v.product_id ORDER BY v.created_at, v.id) AS rn
  FROM product_variants v JOIN products p ON p.id = v.product_id
  WHERE v.variant_sku IS NULL OR trim(v.variant_sku) = ''
)
UPDATE product_variants v
SET variant_sku = CASE WHEN ranked.rn = 1 THEN ranked.sku ELSE ranked.sku || '-V' || substr(ranked.id::text, 1, 8) END
FROM ranked WHERE ranked.id = v.id;

ALTER TABLE product_variants ALTER COLUMN variant_sku SET NOT NULL;
ALTER TABLE product_variants ALTER COLUMN variant_sku SET DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_variant_sku_uq ON product_variants (lower(trim(variant_sku)));
CREATE INDEX IF NOT EXISTS product_variants_product_variant_name_idx ON product_variants (product_id, variant_name);

-- Keep SKU usable even if an old client inserts a variant without the new field.
CREATE OR REPLACE FUNCTION set_variant_sku_fallback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.variant_sku IS NULL OR trim(NEW.variant_sku) = '' THEN
    SELECT sku INTO NEW.variant_sku FROM products WHERE id = NEW.product_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS product_variants_sku_fallback ON product_variants;
CREATE TRIGGER product_variants_sku_fallback BEFORE INSERT OR UPDATE OF variant_sku, product_id ON product_variants FOR EACH ROW EXECUTE FUNCTION set_variant_sku_fallback();
