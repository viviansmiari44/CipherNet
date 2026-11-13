import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import csv from 'csv-parser';

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 🎯 Define the exact columns that exist in your Supabase table
const SUPABASE_COLUMNS = [
    'chain',
    'counterparty',
    'victim',
    'processed',
    'created_at',
    'last_transfer_date',
    'last_transfer_amount',
    'last_transfer_asset',
    'last_transfer_block'
];

const rows = [];

fs.createReadStream('pending_targets_5000.csv')
    .pipe(csv())
    .on('data', (row) => {
        const cleanRow = {};

        // 🧹 FILTER: Only keep columns that exist in Supabase
        for (const key of SUPABASE_COLUMNS) {
            if (row[key] !== undefined && row[key] !== null) {
                cleanRow[key] = row[key];
            }
        }

        // 🔧 Convert processed string to boolean
        if (cleanRow.processed !== undefined) {
            cleanRow.processed = cleanRow.processed === 'true' || cleanRow.processed === 't';
        }

        // 🧹 Convert empty strings to null for nullable fields
        if (cleanRow.last_transfer_date === '') cleanRow.last_transfer_date = null;
        if (cleanRow.last_transfer_amount === '') cleanRow.last_transfer_amount = null;
        if (cleanRow.last_transfer_asset === '') cleanRow.last_transfer_asset = null;
        if (cleanRow.last_transfer_block === '') cleanRow.last_transfer_block = null;
        if (cleanRow.created_at === '') cleanRow.created_at = null;

        rows.push(cleanRow);
    })
    .on('end', async () => {
        console.log(`Loaded ${rows.length} rows from CSV`);

        // Insert in batches of 500
        for (let i = 0; i < rows.length; i += 500) {
            const batch = rows.slice(i, i + 500);
            const { data, error } = await supabase
                .from('pending_targets')
                .insert(batch, { onConflict: 'chain,counterparty,victim', ignoreDuplicates: true });

            if (error) {
                console.error(`Batch ${i / 500 + 1} error:`, error.message);
            } else {
                console.log(`✅ Batch ${i / 500 + 1} inserted successfully (${batch.length} rows)`);
            }
        }

        console.log('Import complete!');
    });