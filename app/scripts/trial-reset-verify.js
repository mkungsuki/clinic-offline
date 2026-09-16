'use strict';
// Reads only the freshly seeded synthetic DB, never the user's old database/key.
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const dir=path.resolve(process.env.CLINIC_DATA_DIR||''),app=path.resolve(__dirname,'..');
if(path.dirname(dir)!==app||!/^trial-reset-new-[0-9a-f-]{36}$/.test(path.basename(dir)))throw Error('Invalid synthetic data directory');
if(fs.lstatSync(dir).isSymbolicLink())throw Error('Linked data directory');
const db=new DatabaseSync(path.join(dir,'clinic.db'));
try{
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Integrity');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('References');
 if(db.prepare("SELECT value FROM settings WHERE key='demo_mode'").get()?.value!=='1')throw Error('Not demo');
 if(db.prepare('SELECT COUNT(*) n FROM patients').get().n<1)throw Error('No demo patients');
 db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}finally{db.close();}
