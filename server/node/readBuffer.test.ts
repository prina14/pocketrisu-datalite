import { expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
const { encodeRisuSaveLegacy, encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test('owned HTTP buffer has exactly the legacy framing and survives later encodes', async () => {
    for (const value of [{}, { text: '한글🙂', values: [null, false, 1, -2, 1.5] },
        { payload: randomBytes(2 * 1024 * 1024).toString('base64') }]) {
        const expected = Buffer.from(encodeRisuSaveLegacy(value))
        const result = encodeRisuSaveLegacyBuffer(value)
        expect(Buffer.isBuffer(result)).toBe(true)
        expect(result.equals(expected)).toBe(true)
        for (let i = 0; i < 5; i++) encodeRisuSaveLegacyBuffer({ data: 'x'.repeat(1024 * 1024), i })
        expect(result.equals(expected)).toBe(true)
        expect(await decodeRisuSave(result)).toEqual(await decodeRisuSave(expected))
    }
})
