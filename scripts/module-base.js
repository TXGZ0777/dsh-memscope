import { formatAddress, getMainModuleAddress } from '../lib/win32.js'

const pid = process.argv[2] === undefined ? process.pid : Number(process.argv[2])
console.log(JSON.stringify({ pid, address: formatAddress(getMainModuleAddress(pid)) }))
