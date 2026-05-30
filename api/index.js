import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const SECURE_RANDOM = (min, max) => Math.floor(crypto.randomInt(0, 10000) / 10000 * (max - min + 1)) + min;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-User-Id');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.headers['x-user-id'] || req.body?.userId;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const route = req.url.split('/')[2] || '';
    
    // HELPER: Get user
    const getUser = async () => {
      const { data, error } = await supabase.from('users').select('*').eq('id', userId).single();
      if (error) throw error;
      return data;
    };

    // ROUTES
    if (req.method === 'POST') {
      const body = req.body || {};
      
      if (route === 'init') {
        // Upsert user on first launch
        const { data, error } = await supabase
          .from('users')
          .upsert({ id: userId, username: body.username || 'Player' })
          .select()
          .single();
        if (error) throw error;
        return res.json({ success: true, user: data });
      }

      if (route === 'buy') {
        const user = await getUser();
        const { itemId, currency, price } = body;
        const balance = currency === 'tickets' ? user.tickets : user.diamonds;
        if (balance < price) return res.status(400).json({ error: 'Недостаточно средств' });

        const { error: dbErr } = await supabase.rpc('update_balance_and_inventory', {
          p_user_id: userId, p_currency: currency, p_price: -price, p_item_type: body.type, p_item_id: itemId, p_qty: 1
        });
        // Fallback manual transaction if RPC not pre-created
        const updateCol = currency === 'tickets' ? 'tickets' : 'diamonds';
        const { error } = await supabase.from('users').update({ [updateCol]: balance - price }).eq('id', userId);
        if (error) throw error;

        if (body.type === 'item') {
          await supabase.from('inventory').upsert({ user_id: userId, item_type: body.type, item_id: itemId, quantity: 1 }, { onConflict: 'user_id,item_type,item_id' })
            .rpc('increment_quantity', { p_user_id: userId, p_item_type: body.type, p_item_id: itemId });
        }
        return res.json({ success: true, new_balance: balance - price });
      }

      if (route === 'open_chest' || route === 'open_box') {
        const user = await getUser();
        const keyMap = { common: 150, iron: 500, gold: 800, diamond: 1200, netherite: 2000 };
        const boxType = body.boxType;
        const keyCost = keyMap[boxType] || 0;
        
        if (route === 'open_chest') {
          // Check if user has key in inventory
          const { data: keyData, error: keyErr } = await supabase.from('inventory').select('quantity').eq('user_id', userId).eq('item_type', 'key').eq('item_id', `${boxType}_key`).single();
          if (keyErr || !keyData || keyData.quantity < 1) return res.status(400).json({ error: 'Нет ключа' });
          await supabase.from('inventory').update({ quantity: keyData.quantity - 1 }).eq('user_id', userId).eq('item_type', 'key').eq('item_id', `${boxType}_key`);
        }

        let rewardDiamonds = 0;
        let rewardTickets = 0;
        let canLose = ['common', 'iron', 'gold'].includes(boxType);
        let canDropTickets = boxType === 'netherite';

        const roll = SECURE_RANDOM(0, 100);
        if (canLose) {
          rewardDiamonds = SECURE_RANDOM(-50, 100);
        } else {
          rewardDiamonds = SECURE_RANDOM(100, boxType === 'diamond' ? 800 : 600);
        }
        
        if (canDropTickets) {
          rewardTickets = SECURE_RANDOM(1, 5);
          await supabase.rpc('add_tickets', { p_user_id: userId, p_amount: rewardTickets });
        }

        const newBalance = user.diamonds + rewardDiamonds;
        if (newBalance < 0 && !canLose) throw new Error('Server calculation error');
        
        await supabase.from('users').update({ diamonds: Math.max(0, newBalance) }).eq('id', userId);
        await supabase.from('transactions').insert({ from_user: 0, to_user: userId, amount: rewardDiamonds, type: 'chest', metadata: { box: boxType } });
        
        return res.json({ success: true, diamonds: rewardDiamonds, tickets: rewardTickets });
      }

      if (route === 'play_game') {
        const { game, bet, choice } = body;
        const user = await getUser();
        if (user.diamonds < bet) return res.status(400).json({ error: 'Недостаточно алмазов' });

        let winAmount = 0;
        const validGames = ['casino', 'slots', 'cups', 'coin'];
        if (!validGames.includes(game)) return res.status(400).json({ error: 'Invalid game' });

        if (game === 'casino') {
          if (![10, 15, 20, 40].includes(choice)) return res.status(400).json({ error: 'Invalid number' });
          winAmount = Math.random() * 40 < 1 ? bet * 1.5 : 0; // 2.5% base win, adjust as needed for balance
        } else if (game === 'slots') {
          winAmount = Math.random() < 0.3 ? Math.floor(bet * 0.8) : 0; // Lossy
        } else if (game === 'cups') {
          winAmount = Math.random() < 0.5 ? bet * 2 : 0;
        } else if (game === 'coin') {
          if (bet < 100 || bet > 500) return res.status(400).json({ error: 'Ставка 100-500' });
          winAmount = Math.random() < 0.4 ? bet * 2 : 0;
        }

        const newBalance = user.diamonds - bet + winAmount;
        await supabase.from('users').update({ diamonds: Math.max(0, newBalance) }).eq('id', userId);
        return res.json({ success: true, new_balance: Math.max(0, newBalance), win_amount: winAmount });
      }

      if (route === 'transfer') {
        const { toUserId, amount } = body;
        if (amount > 1000 || amount < 1) return res.status(400).json({ error: 'Лимит перевода 1-1000' });
        
        // Check cooldown
        const { data: config } = await supabase.from('admin_config').select('config_value').eq('config_key', 'economy').single();
        const cooldownHours = config?.config_value?.transfer_cooldown_hours || 72;
        const user = await getUser();
        const last = user.last_transfer_at ? new Date(user.last_transfer_at) : new Date(0);
        const hoursPassed = (Date.now() - last.getTime()) / (1000 * 60 * 60);
        if (hoursPassed < cooldownHours) return res.status(429).json({ error: 'Перевод доступен через некоторое время' });

        // Check friendship
        const { data: friend } = await supabase.from('friends').select('*').eq('user_id', userId).eq('friend_id', toUserId).eq('status', 'accepted').single();
        if (!friend) return res.status(403).json({ error: 'Можно переводить только друзьям' });

        if (user.diamonds < amount) return res.status(400).json({ error: 'Недостаточно алмазов' });

        await supabase.from('users').update({ 
          diamonds: user.diamonds - amount, 
          last_transfer_at: new Date() 
        }).eq('id', userId);
        
        // Add to recipient
        const { data: target } = await getUser(toUserId); // Helper needs refactoring, simplified here
        await supabase.rpc('add_diamonds', { p_user_id: toUserId, p_amount: amount });

        return res.json({ success: true });
      }
    }

    if (req.method === 'GET') {
      if (route === 'user') {
        const user = await getUser();
        return res.json({ user });
      }
    }

    return res.status(404).json({ error: 'Route not found' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal server error', details: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
}
