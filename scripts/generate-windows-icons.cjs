/* eslint-disable no-bitwise, no-mixed-operators, max-depth, unicorn/numeric-separators-style */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const rootDirectory = path.join(__dirname, '..');
const iconDirectory = path.join(rootDirectory, 'build', 'icons');
const staticDirectory = path.join(rootDirectory, 'static');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) {
		value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
	}

	crcTable[index] = value >>> 0;
}

function crc32(buffer) {
	let crc = 0xFFFFFFFF;
	for (const byte of buffer) {
		crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
	}

	return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPngChunk(type, data) {
	const typeBuffer = Buffer.from(type, 'ascii');
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
	return chunk;
}

function encodePng({width, height, pixels}) {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;

	const scanlines = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		const scanlineOffset = y * (width * 4 + 1);
		scanlines[scanlineOffset] = 0;
		pixels.copy(scanlines, scanlineOffset + 1, y * width * 4, (y + 1) * width * 4);
	}

	return Buffer.concat([
		pngSignature,
		createPngChunk('IHDR', header),
		createPngChunk('IDAT', zlib.deflateSync(scanlines, {level: 9})),
		createPngChunk('IEND', Buffer.alloc(0)),
	]);
}

function paethPredictor(left, above, upperLeft) {
	const prediction = left + above - upperLeft;
	const leftDistance = Math.abs(prediction - left);
	const aboveDistance = Math.abs(prediction - above);
	const upperLeftDistance = Math.abs(prediction - upperLeft);
	if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
		return left;
	}

	return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(filePath) {
	const png = fs.readFileSync(filePath);
	if (!png.subarray(0, pngSignature.length).equals(pngSignature)) {
		throw new Error(`Not a PNG: ${filePath}`);
	}

	let width;
	let height;
	let bitDepth;
	let colorType;
	let interlaceMethod;
	const compressedData = [];
	for (let offset = pngSignature.length; offset < png.length;) {
		const length = png.readUInt32BE(offset);
		const type = png.toString('ascii', offset + 4, offset + 8);
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === 'IHDR') {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			bitDepth = data[8];
			colorType = data[9];
			interlaceMethod = data[12];
		} else if (type === 'IDAT') {
			compressedData.push(data);
		}

		offset += length + 12;
	}

	if (!width || !height || bitDepth !== 8 || colorType !== 6 || interlaceMethod !== 0) {
		throw new Error(`Unsupported PNG format: ${filePath}`);
	}

	const channelCount = 4;
	const rowLength = width * channelCount;
	const inflated = zlib.inflateSync(Buffer.concat(compressedData));
	const pixels = Buffer.alloc(width * height * channelCount);
	let previousRow = Buffer.alloc(rowLength);
	let sourceOffset = 0;
	for (let y = 0; y < height; y++) {
		const filter = inflated[sourceOffset++];
		const row = Buffer.from(inflated.subarray(sourceOffset, sourceOffset + rowLength));
		sourceOffset += rowLength;

		for (let index = 0; index < rowLength; index++) {
			const left = index >= channelCount ? row[index - channelCount] : 0;
			const above = previousRow[index];
			const upperLeft = index >= channelCount ? previousRow[index - channelCount] : 0;
			switch (filter) {
				case 0: {
					break;
				}

				case 1: {
					row[index] = (row[index] + left) & 0xFF;
					break;
				}

				case 2: {
					row[index] = (row[index] + above) & 0xFF;
					break;
				}

				case 3: {
					row[index] = (row[index] + Math.floor((left + above) / 2)) & 0xFF;
					break;
				}

				case 4: {
					row[index] = (row[index] + paethPredictor(left, above, upperLeft)) & 0xFF;
					break;
				}

				default: {
					throw new Error(`Unsupported PNG filter: ${filter}`);
				}
			}
		}

		row.copy(pixels, y * rowLength);
		previousRow = row;
	}

	return {width, height, pixels};
}

function lanczos(value, radius = 3) {
	const distance = Math.abs(value);
	if (distance === 0) {
		return 1;
	}

	if (distance >= radius) {
		return 0;
	}

	return radius * Math.sin(Math.PI * distance) * Math.sin(Math.PI * distance / radius)
		/ (Math.PI * Math.PI * distance * distance);
}

function resizePng(source, size) {
	const pixels = Buffer.alloc(size * size * 4);
	const scale = source.width / size;
	const filterScale = Math.max(1, scale);
	const filterRadius = 3 * filterScale;

	for (let targetY = 0; targetY < size; targetY++) {
		const sourceY = (targetY + 0.5) * scale - 0.5;
		const minimumY = Math.max(0, Math.ceil(sourceY - filterRadius));
		const maximumY = Math.min(source.height - 1, Math.floor(sourceY + filterRadius));
		for (let targetX = 0; targetX < size; targetX++) {
			const sourceX = (targetX + 0.5) * scale - 0.5;
			const minimumX = Math.max(0, Math.ceil(sourceX - filterRadius));
			const maximumX = Math.min(source.width - 1, Math.floor(sourceX + filterRadius));
			let weightTotal = 0;
			let alphaTotal = 0;
			const premultipliedColor = [0, 0, 0];

			for (let y = minimumY; y <= maximumY; y++) {
				const yWeight = lanczos((sourceY - y) / filterScale) / filterScale;
				for (let x = minimumX; x <= maximumX; x++) {
					const weight = yWeight * lanczos((sourceX - x) / filterScale) / filterScale;
					const sourceOffset = (y * source.width + x) * 4;
					const alpha = source.pixels[sourceOffset + 3] / 255;
					weightTotal += weight;
					alphaTotal += alpha * weight;
					for (let channel = 0; channel < 3; channel++) {
						premultipliedColor[channel] += source.pixels[sourceOffset + channel] * alpha * weight;
					}
				}
			}

			const targetOffset = (targetY * size + targetX) * 4;
			if (alphaTotal > 0) {
				for (let channel = 0; channel < 3; channel++) {
					pixels[targetOffset + channel] = Math.max(0, Math.min(255, Math.round(premultipliedColor[channel] / alphaTotal)));
				}
			}

			pixels[targetOffset + 3] = Math.max(0, Math.min(255, Math.round(alphaTotal / weightTotal * 255)));
		}
	}

	return encodePng({width: size, height: size, pixels});
}

function createIco(images) {
	const headerSize = 6 + images.length * 16;
	const header = Buffer.alloc(headerSize);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);

	let imageOffset = headerSize;
	for (const [index, image] of images.entries()) {
		const entryOffset = 6 + index * 16;
		header[entryOffset] = image.size === 256 ? 0 : image.size;
		header[entryOffset + 1] = image.size === 256 ? 0 : image.size;
		header.writeUInt16LE(1, entryOffset + 4);
		header.writeUInt16LE(32, entryOffset + 6);
		header.writeUInt32LE(image.data.length, entryOffset + 8);
		header.writeUInt32LE(imageOffset, entryOffset + 12);
		imageOffset += image.data.length;
	}

	return Buffer.concat([header, ...images.map(image => image.data)]);
}

function verifyIco(filePath, expectedSizes) {
	const icon = fs.readFileSync(filePath);
	const imageCount = icon.readUInt16LE(4);
	if (icon.readUInt16LE(0) !== 0 || icon.readUInt16LE(2) !== 1 || imageCount !== expectedSizes.length) {
		throw new Error(`Invalid ICO header: ${filePath}`);
	}

	const actualSizes = [];
	for (let index = 0; index < imageCount; index++) {
		const entryOffset = 6 + index * 16;
		const width = icon[entryOffset] || 256;
		const height = icon[entryOffset + 1] || 256;
		const imageLength = icon.readUInt32LE(entryOffset + 8);
		const imageOffset = icon.readUInt32LE(entryOffset + 12);
		if (width !== height || imageOffset + imageLength > icon.length) {
			throw new Error(`Invalid ICO entry: ${filePath}`);
		}

		if (!icon.subarray(imageOffset, imageOffset + pngSignature.length).equals(pngSignature)) {
			throw new Error(`ICO entry is not a PNG: ${filePath}`);
		}

		actualSizes.push(width);
	}

	if (actualSizes.some((size, index) => size !== expectedSizes[index])) {
		throw new Error(`Unexpected ICO sizes: ${actualSizes.join(', ')}`);
	}

	return actualSizes;
}

function readAppIcon(size) {
	return fs.readFileSync(path.join(iconDirectory, `${size}x${size}.png`));
}

// Preserve the original Caprine artwork at every existing authored size. Only
// the DPI-specific sizes missing from the repository are resampled.
const appIcon32 = decodePng(path.join(iconDirectory, '32x32.png'));
const appIcon48 = decodePng(path.join(iconDirectory, '48x48.png'));
const generatedAppIcons = new Map([
	[20, resizePng(appIcon32, 20)],
	[24, resizePng(appIcon32, 24)],
	[40, resizePng(appIcon48, 40)],
]);
for (const [size, data] of generatedAppIcons) {
	fs.writeFileSync(path.join(iconDirectory, `${size}x${size}.png`), data);
}

const appIconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const appImages = appIconSizes.map(size => ({
	size,
	data: generatedAppIcons.get(size) ?? readAppIcon(size),
}));

const appIconPath = path.join(rootDirectory, 'build', 'icon.ico');
fs.writeFileSync(appIconPath, createIco(appImages));

const traySizes = [16, 20, 24, 32, 40];
function createTrayIco(sourceFileName) {
	const source = decodePng(path.join(staticDirectory, sourceFileName));
	return createIco(traySizes.map(size => ({size, data: resizePng(source, size)})));
}

const trayIconPath = path.join(staticDirectory, 'IconTray.ico');
const unreadTrayIconPath = path.join(staticDirectory, 'IconTrayUnread.ico');
fs.writeFileSync(trayIconPath, createTrayIco('IconTray@2x.png'));
fs.writeFileSync(unreadTrayIconPath, createTrayIco('IconTrayUnread@2x.png'));

verifyIco(appIconPath, appIconSizes);
verifyIco(trayIconPath, traySizes);
verifyIco(unreadTrayIconPath, traySizes);
console.log(`Generated Windows app icon from original artwork (${appIconSizes.join(', ')} px)`);
console.log(`Generated Windows tray icons from original artwork (${traySizes.join(', ')} px)`);
