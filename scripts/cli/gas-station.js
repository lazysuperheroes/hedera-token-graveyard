#!/usr/bin/env node
/**
 * LazyGasStation Admin Operations
 * Manage contract users and check wiring for the LazyGasStation contract
 *
 * Usage:
 *   node scripts/cli/gas-station.js <command> [options]
 *
 * Commands:
 *   check                     Check if graveyard is wired as a contract user
 *   add-user <contractId>     Add a contract as a contract user
 *   remove-user <contractId>  Remove a contract user
 *   list-users                List all contract users
 *   wire-graveyard            Wire graveyard as contract user (shortcut)
 *
 * Options:
 *   --confirm           Skip confirmation prompt (for scripting)
 *   --json              Output in JSON format
 *   --help, -h          Show help
 */

const readline = require('readline');
const { ethers } = require('ethers');
const { ContractId } = require('@hashgraph/sdk');
const { homebrewPopulateAccountEvmAddress, EntityType } = require('../../utils/hederaMirrorHelpers');
const { contractExecuteFunction, readOnlyEVMFromMirrorNode } = require('../../utils/solidityHelpers');
const { createClient, loadABI, getContractConfig } = require('./lib/client');
const {
	initOutputMode,
	isJsonMode,
	createResponse,
	output,
	header,
	row,
	success,
	error,
	warning,
} = require('./lib/format');

// Initialize output mode
initOutputMode();

const GAS_LIMIT = 400_000;

/**
 * Set up LazyGasStation interface and IDs
 */
function setupGasStation() {
	const { client, operatorId, env } = createClient();
	const config = getContractConfig();

	if (!config.lazyGasStationId) {
		throw new Error('LAZY_GAS_STATION_CONTRACT_ID not set in .env');
	}

	const abi = loadABI('LazyGasStation');
	const iface = new ethers.Interface(abi);

	return { iface, gasStationId: config.lazyGasStationId, client, env, operatorId, config };
}

/**
 * Read-only query on the gas station
 */
async function queryGasStation(functionName, params = []) {
	const { iface, gasStationId, env, operatorId } = setupGasStation();
	const encodedCall = iface.encodeFunctionData(functionName, params);
	const result = await readOnlyEVMFromMirrorNode(env, gasStationId, encodedCall, operatorId, false);
	return iface.decodeFunctionResult(functionName, result);
}

/**
 * Execute a write function on the gas station
 */
async function executeGasStation(functionName, params = []) {
	const { iface, gasStationId, client } = setupGasStation();
	const [receipt, result, record] = await contractExecuteFunction(
		gasStationId,
		iface,
		client,
		GAS_LIMIT,
		functionName,
		params,
	);
	return {
		status: receipt?.status?.toString() || 'UNKNOWN',
		result,
		record,
	};
}

/**
 * Ask for confirmation
 */
async function confirm(message) {
	if (process.argv.includes('--confirm')) {
		return true;
	}

	if (isJsonMode()) {
		error('Use --confirm flag for non-interactive mode');
		process.exit(2);
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise(resolve => {
		rl.question(`  ${message} (yes/no): `, answer => {
			rl.close();
			resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
		});
	});
}

/**
 * Check if graveyard is wired as a contract user of the gas station
 */
async function checkWiring() {
	const { env, config } = setupGasStation();

	if (!config.graveyardId) {
		throw new Error('GRAVEYARD_CONTRACT_ID not set in .env');
	}

	const graveyardAddress = await homebrewPopulateAccountEvmAddress(env, config.graveyardId.toString(), EntityType.CONTRACT);

	if (!isJsonMode()) {
		header('LazyGasStation Wiring Check');
		row('Gas Station', config.lazyGasStationId.toString());
		row('Graveyard', config.graveyardId.toString());
		row('Graveyard EVM', graveyardAddress);
		console.log('');
		console.log('  Checking...');
	}

	const result = await queryGasStation('isContractUser', [graveyardAddress]);
	const isWired = result[0];

	if (isJsonMode()) {
		output(createResponse(true, {
			gasStation: config.lazyGasStationId.toString(),
			graveyard: config.graveyardId.toString(),
			graveyardEvmAddress: graveyardAddress,
			isContractUser: isWired,
		}));
	} else {
		if (isWired) {
			success('Graveyard IS wired as a contract user of LazyGasStation');
		} else {
			warning('Graveyard is NOT a contract user of LazyGasStation');
			console.log('  Run: node scripts/cli/gas-station.js wire-graveyard');
		}
	}
}

/**
 * List all contract users on the gas station
 */
async function listUsers() {
	const { config } = setupGasStation();

	if (!isJsonMode()) {
		header('LazyGasStation Contract Users');
		row('Gas Station', config.lazyGasStationId.toString());
		console.log('');
	}

	const result = await queryGasStation('getContractUsers', []);
	const users = result[0];

	if (isJsonMode()) {
		output(createResponse(true, {
			gasStation: config.lazyGasStationId.toString(),
			contractUsers: users.map(u => u.toString()),
			count: users.length,
		}));
	} else {
		if (users.length === 0) {
			warning('No contract users registered');
		} else {
			console.log(`  Found ${users.length} contract user(s):\n`);
			users.forEach((addr, i) => {
				console.log(`    ${i + 1}. ${addr}`);
			});
			console.log('');
		}
	}
}

/**
 * Add a contract user to the gas station
 */
async function addUser(contractIdStr) {
	const { env, config } = setupGasStation();
	const evmAddress = await homebrewPopulateAccountEvmAddress(env, contractIdStr, EntityType.CONTRACT);

	if (!isJsonMode()) {
		header('Add Contract User to LazyGasStation');
		row('Gas Station', config.lazyGasStationId.toString());
		row('Contract', contractIdStr);
		row('EVM Address', evmAddress);
		console.log('');
	}

	// Check if already a contract user
	const checkResult = await queryGasStation('isContractUser', [evmAddress]);
	if (checkResult[0]) {
		if (isJsonMode()) {
			output(createResponse(true, {
				operation: 'addContractUser',
				contract: contractIdStr,
				message: 'Already a contract user',
			}));
		} else {
			warning(`${contractIdStr} is already a contract user`);
		}
		return;
	}

	const confirmed = await confirm(`Add ${contractIdStr} as contract user of LazyGasStation?`);
	if (!confirmed) {
		if (isJsonMode()) {
			output(createResponse(false, null, { message: 'Cancelled by user' }));
		} else {
			warning('Cancelled');
		}
		return;
	}

	const result = await executeGasStation('addContractUser', [evmAddress]);

	if (isJsonMode()) {
		output(createResponse(result.status === 'SUCCESS', {
			operation: 'addContractUser',
			contract: contractIdStr,
			evmAddress,
			status: result.status,
		}));
	} else {
		if (result.status === 'SUCCESS') {
			success(`Contract user added: ${contractIdStr}`);
		} else {
			error(`Failed: ${result.status}`);
		}
	}
}

/**
 * Remove a contract user from the gas station
 */
async function removeUser(contractIdStr) {
	const { env, config } = setupGasStation();
	const evmAddress = await homebrewPopulateAccountEvmAddress(env, contractIdStr, EntityType.CONTRACT);

	if (!isJsonMode()) {
		header('Remove Contract User from LazyGasStation');
		row('Gas Station', config.lazyGasStationId.toString());
		row('Contract', contractIdStr);
		console.log('');
	}

	const confirmed = await confirm(`Remove ${contractIdStr} from LazyGasStation contract users?`);
	if (!confirmed) {
		if (isJsonMode()) {
			output(createResponse(false, null, { message: 'Cancelled by user' }));
		} else {
			warning('Cancelled');
		}
		return;
	}

	const result = await executeGasStation('removeContractUser', [evmAddress]);

	if (isJsonMode()) {
		output(createResponse(result.status === 'SUCCESS', {
			operation: 'removeContractUser',
			contract: contractIdStr,
			status: result.status,
		}));
	} else {
		if (result.status === 'SUCCESS') {
			success(`Contract user removed: ${contractIdStr}`);
		} else {
			error(`Failed: ${result.status}`);
		}
	}
}

/**
 * Wire graveyard as contract user (convenience shortcut)
 */
async function wireGraveyard() {
	const { config } = setupGasStation();

	if (!config.graveyardId) {
		throw new Error('GRAVEYARD_CONTRACT_ID not set in .env');
	}

	await addUser(config.graveyardId.toString());
}

/**
 * Show help
 */
function showHelp() {
	console.log(`
LazyGasStation Admin Operations

Usage:
  node scripts/cli/gas-station.js <command> [options]

Commands:
  check                     Check if graveyard is wired as a contract user
  add-user <contractId>     Add a contract as a contract user (e.g., 0.0.12345)
  remove-user <contractId>  Remove a contract user
  list-users                List all contract users
  wire-graveyard            Wire graveyard as contract user (shortcut for add-user)

Options:
  --json              Output in JSON format
  --confirm           Skip confirmation prompt
  --help, -h          Show this help

Examples:
  node scripts/cli/gas-station.js check
  node scripts/cli/gas-station.js wire-graveyard --confirm
  node scripts/cli/gas-station.js add-user 0.0.8019693
  node scripts/cli/gas-station.js list-users --json
`);
}

/**
 * Main entry point
 */
async function main() {
	const args = process.argv.slice(2).filter(arg => !arg.startsWith('-'));
	const command = args[0];

	if (process.argv.includes('--help') || process.argv.includes('-h') || !command) {
		showHelp();
		process.exit(command ? 0 : 2);
	}

	try {
		switch (command) {
		case 'check':
			await checkWiring();
			break;
		case 'list-users':
			await listUsers();
			break;
		case 'add-user':
			if (!args[1]) {
				error('Contract ID required (e.g., 0.0.12345)');
				process.exit(2);
			}
			await addUser(args[1]);
			break;
		case 'remove-user':
			if (!args[1]) {
				error('Contract ID required');
				process.exit(2);
			}
			await removeUser(args[1]);
			break;
		case 'wire-graveyard':
			await wireGraveyard();
			break;
		default:
			error(`Unknown command: ${command}`);
			showHelp();
			process.exit(2);
		}
		process.exit(0);
	} catch (err) {
		if (isJsonMode()) {
			output(createResponse(false, null, err));
		} else {
			error(err.message);
		}
		process.exit(1);
	}
}

main();
