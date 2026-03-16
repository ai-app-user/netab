# app_helpers/pos

`PosHelper` is the simplified POS-facing API built on top of `netab`.

Exposed methods:

- `init`
- `onboarding_options`
- `connect_by_qr`
- `connect_by_location_id`
- `connect_by_brand_name`
- `connect_select_site`
- `menu_list`
- `menu_upsert`
- `menu_set_availability`
- `order_create`
- `order_list`
- `order_subscribe`
- `get_context`
- `set_context`

The intent is that the UI layer works with menu/order primitives and does not need to understand JWTs, cluster routing, or raw table operations.
