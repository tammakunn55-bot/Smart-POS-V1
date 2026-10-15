const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateCountCreate(input={}) {
  const title=String(input.title||'').trim();
  const location=String(input.location||'').trim();
  const reason=String(input.reason||'').trim();
  const variant_ids=input.variant_ids;
  if(title.length<3||title.length>120)return {error:'ชื่อรอบตรวจนับต้องมี 3-120 ตัวอักษร'};
  if(location.length>120)return {error:'ตำแหน่งคลัง/ชั้นวางต้องไม่เกิน 120 ตัวอักษร'};
  if(reason.length>500)return {error:'หมายเหตุต้องไม่เกิน 500 ตัวอักษร'};
  if(variant_ids!==undefined&&(!Array.isArray(variant_ids)||variant_ids.length<1||variant_ids.length>2000||variant_ids.some(id=>!UUID.test(String(id)))||new Set(variant_ids).size!==variant_ids.length))return {error:'รายการสินค้าต้องเป็น UUID ที่ไม่ซ้ำกัน 1-2,000 รายการ'};
  return {title,location,reason,variant_ids:variant_ids||null};
}
export function validateCountQuantity(input={}) {
  const quantity=Number(input.counted_quantity);
  if(input.counted_quantity===null||input.counted_quantity===undefined||input.counted_quantity===''||!Number.isFinite(quantity)||quantity<0||quantity>999999999||Math.abs(Math.round(quantity*1000)-quantity*1000)>1e-7)return {error:'จำนวนตรวจนับต้องเป็นตัวเลขตั้งแต่ 0 ถึง 999,999,999 และไม่เกิน 3 ตำแหน่งทศนิยม'};
  return {counted_quantity:quantity};
}
export function calculateCountDelta(snapshotQuantity,countedQuantity){
  const snapshot=Number(snapshotQuantity),counted=Number(countedQuantity);
  if(!Number.isFinite(snapshot)||snapshot<0||!Number.isFinite(counted)||counted<0)throw new TypeError('จำนวนสต็อกไม่ถูกต้อง');
  return Math.round((counted-snapshot)*1000)/1000;
}
