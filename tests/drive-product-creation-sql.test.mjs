import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

test('Drive transaction persists real metadata and drafts; retries, failures and permissions are safe', async () => {
  assert.ok(process.env.PGLITE_MODULE, 'Run with scripts/smart-test-runner.mjs');
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create type product_status as enum ('draft','pending_price');
      create type marketplace_code as enum ('mercado_livre','shopee');
      create table products (
        id uuid primary key default gen_random_uuid(), sku text unique not null, source_key text unique not null,
        type_code text, brand_code text, special_code text, model text, version text, board_code text, title text,
        price numeric, stock integer, status product_status, marketplace_categories jsonb, marketplace_attributes jsonb,
        marketplace_attribute_schema_version integer, width numeric, height numeric, length numeric, weight_net numeric, weight_gross numeric
      );
      create table config_marketplace_accounts(id uuid primary key);
      create table product_images (
        id uuid primary key default gen_random_uuid(), product_id uuid references products(id), drive_file_id text,
        original_name text, url text, local_url text, local_path text, bytes bigint, width_px integer, height_px integer,
        position integer, status text, cloudinary_url text, unique(product_id,position)
      );
      create table listings (
        id uuid primary key default gen_random_uuid(), product_id uuid references products(id), marketplace marketplace_code,
        marketplace_account_id uuid references config_marketplace_accounts(id), marketplace_name text, external_sku text,
        status product_status, stock integer, price numeric
      );
    `);
    await db.exec(readFileSync('supabase/migrations/20261102232000_atomic_drive_product_creation.sql', 'utf8'));
    const product = { source_key: 'TYPE_BRAND_MODEL', sku: '1PP', title: 'Product', stock: 1,
      marketplace_categories: { mercado_livre: 'MLB1' }, marketplace_attributes: {}, marketplace_attribute_schema_version: 2 };
    const hash = value => createHash('sha256').update(value).digest('hex');
    const source = hash(product.source_key);
    const images = [1, 2, 3].map(position => {
      const local_path = `produtos/${source.slice(0, 2)}/${source}/${position}-${hash(String(position))}.jpg`;
      const url = 'https://api.gestaomarketplace.tech/Imagens/' + local_path;
      return { drive_file_id: String(position), original_name: `${position}.jpg`, position, url, local_url: url,
        local_path, bytes: 1234 + position, width_px: 1200, height_px: 600 };
    });
    const accounts = [{ marketplace: 'mercado_livre', name: 'ML' }, { marketplace: 'shopee', name: 'Shopee' }];
    const invoke = async (p = product, i = images, a = accounts) => (await db.query(
      'select create_drive_product_atomically($1::jsonb,$2::jsonb,$3::jsonb) as result',
      [JSON.stringify(p), JSON.stringify(i), JSON.stringify(a)])).rows[0].result;

    // Failure during drafts rolls back the product and images too.
    await assert.rejects(invoke(product, images, [{ marketplace: 'invalid' }]), /invalid input value/);
    assert.equal((await db.query('select count(*)::integer as n from products')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::integer as n from product_images')).rows[0].n, 0);
    // Simulate a storage/database constraint failure after the product insert.
    await db.exec("alter table product_images add constraint fail_image check (bytes < 1000)");
    await assert.rejects(invoke(), /fail_image/);
    assert.equal((await db.query('select count(*)::integer as n from products')).rows[0].n, 0);
    await db.exec('alter table product_images drop constraint fail_image');

    const results = await Promise.all([invoke(), invoke()]);
    assert.deepEqual(results.map(r => r.created), [true, false]);
    assert.equal(results[0].id, results[1].id);
    const saved = (await db.query('select * from product_images order by position')).rows;
    assert.deepEqual(saved.map(r => r.url), images.map(i => i.url));
    assert.deepEqual(saved.map(r => Number(r.bytes)), images.map(i => i.bytes));
    assert.ok(saved.every(r => r.width_px === 1200 && r.height_px === 600 && r.cloudinary_url === null));
    assert.deepEqual((await db.query('select status::text,price::integer from products')).rows, [{ status: 'pending_price', price: 0 }]);
    assert.equal((await db.query("select count(*)::integer as n from listings where status='draft'")).rows[0].n, 2);
    // Existing products (including legacy ones) are never rewritten by retries.
    assert.equal((await invoke({ ...product, sku: 'OTHER' }, [])).created, false);
    assert.equal((await db.query('select sku from products')).rows[0].sku, product.sku);
    const acl = (await db.query(`select
      has_function_privilege('anon','create_drive_product_atomically(jsonb,jsonb,jsonb)','execute') as anon,
      has_function_privilege('authenticated','create_drive_product_atomically(jsonb,jsonb,jsonb)','execute') as authenticated,
      has_function_privilege('service_role','create_drive_product_atomically(jsonb,jsonb,jsonb)','execute') as service`)).rows[0];
    assert.deepEqual(acl, { anon: false, authenticated: false, service: true });

    await db.exec('truncate listings,product_images,products');
    for (const invalid of [
      [], [images[0], images[0]], [{ ...images[0], width_px: 1201 }], [{ ...images[0], bytes: null }],
      [{ ...images[0], url: 'https://attacker.test/image.jpg' }], [{ ...images[0], local_path: '../escape.jpg' }]
    ]) await assert.rejects(invoke(product, invalid));
    assert.equal((await db.query('select count(*)::integer as n from products')).rows[0].n, 0);
  } finally { await db.close(); }
});
