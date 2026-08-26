# Inventory allocator

`createInventory()` -> `{ addLot, allocate, release, onHand, reserved }`.

- `addLot(sku, lotId, qty, expiresDay)`: register stock. Duplicate lotId for a sku:
  throw Error `duplicate lot <lotId>`. qty must be a positive integer: throw
  Error `bad qty` otherwise.
- `allocate(sku, qty, ref)`: reserve `qty` units under reservation name `ref`,
  drawing from unexpired-order lots First-Expiry-First-Out; tie on expiresDay
  breaks by lotId ascending (string compare). Partial fills are FORBIDDEN: if total
  available < qty, throw Error `short <missing> of <sku>` (missing = qty - available)
  and change nothing. A ref already in use (unreleased): throw Error `ref in use <ref>`.
  Returns the draw plan `[{ lotId, qty }, ...]` in draw order.
- `release(ref)`: return the reservation's units to their lots. Unknown or already
  released ref: throw Error `unknown ref <ref>`. Releasing twice must throw.
- `onHand(sku)` -> unreserved total. `reserved(sku)` -> reserved total.
- Unknown sku anywhere it is read: treat as zero stock (allocate throws short).
