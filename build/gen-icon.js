#!/usr/bin/env node
// アイコン生成スクリプト: build/icon.png を生成する
// 実行: node build/gen-icon.js
// 必要: canvas パッケージ (npm install canvas --save-dev)
// または手動で 512x512 の PNG を build/icon.png に配置してください

const { createCanvas } = require('canvas');
const fs = require('fs');
const path = require('path');

const SIZE = 512;
const canvas = createCanvas(SIZE, SIZE);
const ctx = canvas.getContext('2d');

// 背景（角丸）
const r = SIZE * 0.2;
ctx.beginPath();
ctx.moveTo(r, 0);
ctx.lineTo(SIZE - r, 0);
ctx.quadraticCurveTo(SIZE, 0, SIZE, r);
ctx.lineTo(SIZE, SIZE - r);
ctx.quadraticCurveTo(SIZE, SIZE, SIZE - r, SIZE);
ctx.lineTo(r, SIZE);
ctx.quadraticCurveTo(0, SIZE, 0, SIZE - r);
ctx.lineTo(0, r);
ctx.quadraticCurveTo(0, 0, r, 0);
ctx.closePath();

const grad = ctx.createLinearGradient(0, 0, SIZE, SIZE);
grad.addColorStop(0, '#1e1e2e');
grad.addColorStop(1, '#313244');
ctx.fillStyle = grad;
ctx.fill();

// カメラボディ
ctx.fillStyle = '#cba6f7';
ctx.beginPath();
// ボディ
ctx.roundRect(80, 160, 352, 240, 24);
ctx.fill();

// レンズ（白円）
ctx.fillStyle = '#1e1e2e';
ctx.beginPath();
ctx.arc(256, 272, 80, 0, Math.PI * 2);
ctx.fill();

ctx.fillStyle = '#89b4fa';
ctx.beginPath();
ctx.arc(256, 272, 58, 0, Math.PI * 2);
ctx.fill();

ctx.fillStyle = '#cdd6f4';
ctx.beginPath();
ctx.arc(256, 272, 30, 0, Math.PI * 2);
ctx.fill();

// ファインダー
ctx.fillStyle = '#1e1e2e';
ctx.beginPath();
ctx.roundRect(160, 120, 100, 52, 12);
ctx.fill();

// 書き出し
const out = path.join(__dirname, 'icon.png');
fs.writeFileSync(out, canvas.toBuffer('image/png'));
console.log('Generated:', out);
