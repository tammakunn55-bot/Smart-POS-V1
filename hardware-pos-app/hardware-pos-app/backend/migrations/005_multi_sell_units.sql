-- Sellable packaging units; inventory remains tracked in the product variant's base unit.
CREATE TABLE IF NOT EXISTS product_sell_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  unit_name text NOT NULL CHECK (length(trim(unit_name)) BETWEEN 1 AND 40),
  barcode text UNIQUE,
  conversion_factor numeric(14,3) NOT NULL CHECK (conversion_factor > 1),
  sale_price numeric(14,2) NOT NULL CHECK (sale_price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(variant_id, unit_name)
);
CREATE INDEX IF NOT EXISTS product_sell_units_variant_idx ON product_sell_units(variant_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS product_sell_units_barcode_idx ON product_sell_units(barcode) WHERE is_active;
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS sold_unit_id uuid REFERENCES product_sell_units(id) ON DELETE SET NULL;
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS unit_conversion_factor numeric(14,3) NOT NULL DEFAULT 1 CHECK (unit_conversion_factor > 0);
ALTER TABLE bill_items ADD COLUMN IF NOT EXISTS base_quantity numeric(14,3) NOT NULL DEFAULT 0 CHECK (base_quantity >= 0);
UPDATE bill_items SET base_quantity=quantity WHERE base_quantity=0;

-- Enforce barcode uniqueness across base variants and packaging units, not just within each table.
CREATE OR REPLACE FUNCTION enforce_global_product_barcode_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'product_sell_units' THEN
    IF EXISTS (SELECT 1 FROM product_variants WHERE id=NEW.variant_id AND lower(trim(unit_name))=lower(trim(NEW.unit_name))) THEN
      RAISE EXCEPTION 'sell unit must differ from base unit name' USING ERRCODE = '23505';
    END IF;
  END IF;
  IF NEW.barcode IS NOT NULL AND trim(NEW.barcode) <> '' THEN
    IF TG_TABLE_NAME = 'product_sell_units' THEN
      IF EXISTS (SELECT 1 FROM product_variants WHERE barcode = NEW.barcode) THEN
        RAISE EXCEPTION 'duplicate product barcode' USING ERRCODE = '23505';
      END IF;
      IF EXISTS (SELECT 1 FROM product_sell_units WHERE barcode = NEW.barcode AND id <> COALESCE(NEW.id, gen_random_uuid())) THEN
        RAISE EXCEPTION 'duplicate sell unit barcode' USING ERRCODE = '23505';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM product_sell_units WHERE barcode = NEW.barcode AND id <> COALESCE(NEW.id, gen_random_uuid())) THEN
        RAISE EXCEPTION 'duplicate product barcode' USING ERRCODE = '23505';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS product_sell_units_barcode_unique ON product_sell_units;
CREATE TRIGGER product_sell_units_barcode_unique BEFORE INSERT OR UPDATE OF barcode ON product_sell_units FOR EACH ROW EXECUTE FUNCTION enforce_global_product_barcode_unique();
DROP TRIGGER IF EXISTS product_variants_barcode_unique ON product_variants;
CREATE TRIGGER product_variants_barcode_unique BEFORE INSERT OR UPDATE OF barcode ON product_variants FOR EACH ROW EXECUTE FUNCTION enforce_global_product_barcode_unique();
