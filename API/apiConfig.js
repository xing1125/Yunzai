/**
 * 统一 API 配置模块（非插件，请勿放在 plugins 目录）
 * 使用方式：import { getApiConfig } from '../../lib/apiConfig.js';
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_CONFIG = {
    apiKey: '',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek-chat',
    summaryModel: 'deepseek-chat',
    temperature: 0.9,
    maxTokens: 500,
    summaryTemperature: 0.5,
    summaryMaxTokens: 500,
};

const SEARCH_PATHS = [
    path.join(process.cwd(), 'app/config/ai_config.json'),
    path.join(process.cwd(), 'config/ai_config.json'),
    path.join(process.cwd(), 'configai_config.json'),
    path.join(process.cwd(), 'app/configai_config.json'),
    path.join(process.cwd(), 'plugins/configai_config.json'),
    path.join(process.cwd(), 'data/configai_config.json'),
    'configai_config.json',
];

let cachedConfig = null;
let lastLoadTime = 0;
const CACHE_TTL = 60 * 1000;

function loadFromFile() {
    for (const p of SEARCH_PATHS) {
        if (fs.existsSync(p)) {
            try {
                const raw = fs.readFileSync(p, 'utf-8');
                const cfg = JSON.parse(raw);
                if (cfg.apiKey || cfg.baseURL || cfg.model) {
                    return { ...DEFAULT_CONFIG, ...cfg };
                }
            } catch (_) {}
        }
    }
    return null;
}

function loadFromEnv() {
    const cfg = { ...DEFAULT_CONFIG };
    if (process.env.DEEPSEEK_API_KEY) cfg.apiKey = process.env.DEEPSEEK_API_KEY;
    if (process.env.DEEPSEEK_BASE_URL) cfg.baseURL = process.env.DEEPSEEK_BASE_URL;
    if (process.env.DEEPSEEK_MODEL) cfg.model = process.env.DEEPSEEK_MODEL;
    if (process.env.AI_API_KEY) cfg.apiKey = process.env.AI_API_KEY;
    if (process.env.AI_BASE_URL) cfg.baseURL = process.env.AI_BASE_URL;
    if (process.env.AI_MODEL) cfg.model = process.env.AI_MODEL;
    return cfg;
}

export function getApiConfig() {
    const now = Date.now();
    if (cachedConfig && (now - lastLoadTime) < CACHE_TTL) return cachedConfig;

    const fileCfg = loadFromFile();
    let finalCfg;
    if (fileCfg) {
        logger.info('[apiConfig] 从文件加载配置成功');
        finalCfg = fileCfg;
    } else {
        logger.warn('[apiConfig] 未找到配置文件，使用环境变量');
        finalCfg = loadFromEnv();
    }

    if (!finalCfg.apiKey) logger.warn('[apiConfig] 未配置 API Key');
    finalCfg.baseURL = (finalCfg.baseURL || '').replace(/\/+$/, '');

    cachedConfig = finalCfg;
    lastLoadTime = now;
    return finalCfg;
}

export function refreshConfig() {
    cachedConfig = null;
    lastLoadTime = 0;
    return getApiConfig();
}