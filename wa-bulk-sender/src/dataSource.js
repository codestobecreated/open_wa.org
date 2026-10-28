// =====================================================================================
//  WHERE YOUR CONTACTS COME FROM
//
//  This file has ONE job: getContacts() must return an array like
//      [ { name: 'Ravi Kumar', phone: '98765 43210', optedOut: false }, ... ]
//
//    name      text, may be empty ("there" is used instead)
//    phone     any format: "98765 43210", "+91-98765-43210", "09876543210", 919876543210
//              (the sender cleans it, adds 91 and removes duplicates for you)
//    optedOut  optional. true = never message this person
//
//  Any extra field you return (city, tour, ...) can be used in message.txt as {city}, {tour}.
//
//  To switch from CSV to a database you replace ONLY the body of getContacts().
//  Nothing else in the project changes. See "HOW TO SWITCH FROM CSV TO YOUR DATABASE" below.
// =====================================================================================
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const CSV_FILE = path.join(__dirname, '..', 'contacts.csv');

// "yes", "y", "true", "1", "stop", "opted_out", "unsubscribed" all mean opted out
const isYes = (v) => /^(yes|y|true|1|stop|opted_?out|unsubscribed)$/i.test(String(v ?? '').trim());

async function getContacts() {
  // ---------------- ACTIVE: contacts.csv (columns: name, phone, opted_out) ----------------
  if (!fs.existsSync(CSV_FILE)) throw new Error(`contacts.csv not found at ${CSV_FILE}`);
  const rows = parse(fs.readFileSync(CSV_FILE, 'utf8').replace(/^﻿/, ''), {
    columns: (header) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return rows.map((r) => ({ ...r, name: r.name, phone: r.phone, optedOut: isYes(r.opted_out) }));
}

module.exports = { getContacts };

/* =====================================================================================
   READY-TO-USE EXAMPLES  (copy ONE of them over the body of getContacts() above)

   Each one needs its free npm driver installed once, e.g.  npm install mysql2
   Put your connection details in .env (never in this file).
   ===================================================================================== */

/* ---------------- MySQL  (npm install mysql2) ----------------
   .env:  DB_URL=mysql://USER:PASSWORD@localhost:3306/DATABASE        <-- CHANGE

async function getContacts() {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection(process.env.DB_URL);
  try {
    // CHANGE table/column names. Only pick people who opted in and did not opt out.
    const [rows] = await conn.query(
      `SELECT full_name AS name, mobile AS phone, unsubscribed AS optedOut
         FROM customers
        WHERE whatsapp_opt_in = 1`,
    );
    return rows.map((r) => ({ ...r, optedOut: Boolean(r.optedOut) }));
  } finally {
    await conn.end();
  }
}
*/

/* ---------------- PostgreSQL  (npm install pg) ----------------
   .env:  DB_URL=postgres://USER:PASSWORD@localhost:5432/DATABASE     <-- CHANGE

async function getContacts() {
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DB_URL });
  await client.connect();
  try {
    // CHANGE table/column names
    const { rows } = await client.query(
      `SELECT full_name AS name, mobile AS phone, unsubscribed AS "optedOut"
         FROM customers
        WHERE whatsapp_opt_in = true`,
    );
    return rows;
  } finally {
    await client.end();
  }
}
*/

/* ---------------- MongoDB  (npm install mongodb) ----------------
   .env:  MONGO_URL=mongodb://localhost:27017                          <-- CHANGE
          MONGO_DB=travel                                              <-- CHANGE

async function getContacts() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGO_URL);
  await client.connect();
  try {
    // CHANGE collection/field names
    const docs = await client
      .db(process.env.MONGO_DB)
      .collection('customers')
      .find({ whatsappOptIn: true }, { projection: { name: 1, mobile: 1, unsubscribed: 1 } })
      .toArray();
    return docs.map((d) => ({ name: d.name, phone: d.mobile, optedOut: Boolean(d.unsubscribed) }));
  } finally {
    await client.close();
  }
}
*/

/* ---------------- Google Sheet  (no install needed) ----------------
   In the sheet: File -> Share -> Publish to web -> pick the tab -> "Comma-separated values (.csv)"
   -> Publish -> copy the link.
   .env:  GSHEET_CSV_URL=https://docs.google.com/spreadsheets/d/e/.../pub?output=csv   <-- CHANGE
   The sheet needs the columns: name, phone, opted_out

async function getContacts() {
  const res = await fetch(process.env.GSHEET_CSV_URL);
  if (!res.ok) throw new Error(`Google Sheet download failed: HTTP ${res.status}`);
  const rows = parse(await res.text(), {
    columns: (header) => header.map((h) => h.trim().toLowerCase()),
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
  return rows.map((r) => ({ ...r, optedOut: isYes(r.opted_out) }));
}
*/

/* ---------------- Firebase Firestore  (npm install firebase-admin) ----------------
   Firebase console -> Project settings -> Service accounts -> Generate new private key.
   Save the file as serviceAccount.json in this folder (it is in .gitignore - never share it).

async function getContacts() {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({ credential: admin.credential.cert(require('../serviceAccount.json')) });
  }
  // CHANGE collection/field names
  const snap = await admin.firestore().collection('customers').where('whatsappOptIn', '==', true).get();
  return snap.docs.map((doc) => {
    const d = doc.data();
    return { name: d.name, phone: d.mobile, optedOut: Boolean(d.unsubscribed) };
  });
}
*/

/* =====================================================================================
   HOW TO SWITCH FROM CSV TO YOUR DATABASE IN 5 MINUTES

   1. Install the driver for your database (only one):
        MySQL       npm install mysql2
        PostgreSQL  npm install pg
        MongoDB     npm install mongodb
        Firebase    npm install firebase-admin
        Google Sheet  nothing to install
   2. Add the connection line(s) shown in the example to .env.
   3. Copy the example's getContacts() over the active one at the top of this file
      (replace everything from "async function getContacts() {" to its closing "}").
   4. Change the table / collection / column names marked "CHANGE" to yours.
      Return name, phone and optedOut - rename columns with "AS" (SQL) or in the .map().
      ONLY select customers who agreed to WhatsApp messages.
   5. Check it without sending anything:
        npm run dry-run
      You should see the right number of contacts and the messages they would get.

   Nothing else changes: phone cleaning, opt-outs, logging, resume and limits all keep working.
   ===================================================================================== */
