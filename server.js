const express = require('express');
require('dotenv').config();
const path = require('path');
const nodemailer = require('nodemailer');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs'); // Added fs
const { kv: vercelKv } = require('@vercel/kv'); // Vercel KV

// Local KV Fallback for testing without credentials
const localKv = {
    data: {},
    async set(key, value, options) { this.data[key] = value; },
    async get(key) { return this.data[key]; },
    async del(key) { delete this.data[key]; },
    async lpush(key, value) {
        if (!this.data[key]) this.data[key] = [];
        this.data[key].unshift(value);
    }
};

const kv = process.env.KV_URL ? vercelKv : localKv;
if (!process.env.KV_URL) console.log("Using LOCAL in-memory KV fallback (No KV_URL found)");

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(__dirname)); // Serve static files (index.html, script.js, images)

// Explicitly serve index.html for root path to ensure Vercel handles it correctly
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Nodemailer Helper - Using Google OAuth 2.0
const oauth2Client = new (require('googleapis').google.auth.OAuth2)(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
);

oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        type: 'OAuth2',
        user: process.env.EMAIL,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    }
});

console.log('Nodemailer configuration loaded (OAuth 2.0):');
console.log(`- EMAIL: ${process.env.EMAIL}`);
console.log(`- CLIENT_ID: ${process.env.GOOGLE_CLIENT_ID ? 'Found' : 'MISSING'}`);
console.log(`- CLIENT_SECRET: ${process.env.GOOGLE_CLIENT_SECRET ? 'Found' : 'MISSING'}`);
console.log(`- REFRESH_TOKEN: ${process.env.GOOGLE_REFRESH_TOKEN ? 'Found' : 'MISSING'}`);

// Verify connection configuration
transporter.verify(function (error, success) {
    if (error) {
        console.error("Transporter Verification Error:", error.message);
    } else {
        console.log("Transporter is ready to take messages");
    }
});

// Product Routes
const PRODUCTS_FILE = path.join(__dirname, 'products.json');

app.get('/products', (req, res) => {
    fs.readFile(PRODUCTS_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading products file:', err);
            return res.status(500).json({ error: 'Failed to read products' });
        }
        try {
            const products = JSON.parse(data);
            res.json(products);
        } catch (parseError) {
            console.error('Error parsing products JSON:', parseError);
            res.status(500).json({ error: 'Failed to parse products' });
        }
    });
});

// Multer Configuration
const multer = require('multer');

// Ensure images directory exists
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir);
}

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'images/');
    },
    filename: function (req, file, cb) {
        // Safe filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, 'product-' + uniqueSuffix + ext);
    }
});

const upload = multer({ storage: storage });

app.post('/products', upload.single('image'), (req, res) => {
    const newProduct = req.body;

    // If a file was uploaded, use its path as 'img'
    if (req.file) {
        // Construct URL relative to server
        // Assuming server serves static files from root
        newProduct.img = `images/${req.file.filename}`;
    }

    console.log('Adding new product:', newProduct.name);

    if (!newProduct.name || !newProduct.price || !newProduct.img) {
        // Cleanup file if validation fails
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Name, price, and image are required' });
    }

    fs.readFile(PRODUCTS_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading products file:', err);
            return res.status(500).json({ error: 'Failed to read products' });
        }

        let products = [];
        try {
            products = JSON.parse(data);
        } catch (e) {
            console.error('Error parsing products file, initializing empty array:', e);
            products = [];
        }

        products.push(newProduct);

        fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2), (err) => {
            if (err) {
                console.error('Error writing products file:', err);
                return res.status(500).json({ error: 'Failed to save product' });
            }
            res.json({ success: true, message: 'Product added successfully', product: newProduct });
        });
    });
});

app.delete('/products/bulk', (req, res) => {
    const { indices } = req.body;
    if (!indices || !Array.isArray(indices)) {
        return res.status(400).json({ error: 'Indices array required' });
    }

    fs.readFile(PRODUCTS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read products' });

        let products = [];
        try {
            products = JSON.parse(data);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse products' });
        }

        // Filter out products whose indices are in the delete list
        products = products.filter((_, index) => !indices.includes(index));

        fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to delete products' });
            res.json({ success: true, message: 'Products deleted successfully' });
        });
    });
});

app.delete('/products/:index', (req, res) => {
    const index = parseInt(req.params.index);

    fs.readFile(PRODUCTS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read products' });

        let products = [];
        try {
            products = JSON.parse(data);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse products' });
        }

        if (index < 0 || index >= products.length) {
            return res.status(400).json({ error: 'Invalid product index' });
        }

        const deletedProduct = products.splice(index, 1);

        fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to delete product' });
            res.json({ success: true, message: 'Product deleted', product: deletedProduct });
        });
    });
});

// Update Product
app.put('/products/:index', upload.single('image'), (req, res) => { // Support image upload for edit
    const index = parseInt(req.params.index);
    const updatedData = req.body;

    fs.readFile(PRODUCTS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read products' });
        let products = [];
        try { products = JSON.parse(data); } catch (e) { return res.status(500).json({ error: 'Failed to parse' }); }

        if (index < 0 || index >= products.length) return res.status(400).json({ error: 'Invalid index' });

        // Update fields
        if (updatedData.name) products[index].name = updatedData.name;
        if (updatedData.price) products[index].price = updatedData.price;
        if (updatedData.category) products[index].category = updatedData.category; // Ensure category update support

        // Handle Image Update
        if (req.file) {
            products[index].img = `images/${req.file.filename}`;
        } else if (updatedData.img) {
            // Allow manual URL update if provided
            products[index].img = updatedData.img;
        }

        fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update product' });
            res.json({ success: true, message: 'Product updated', product: products[index] });
        });
    });
});


// Category Routes
const CATEGORIES_FILE = path.join(__dirname, 'categories.json');

app.get('/categories', (req, res) => {
    fs.readFile(CATEGORIES_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading categories file:', err);
            // Fallback to default if file likely doesn't exist
            return res.json([
                { "name": "Phones", "icon": "📱" },
                { "name": "Console", "icon": "🎮" },
                { "name": "Audio", "icon": "🎧" },
                { "name": "Laptops", "icon": "💻" },
                { "name": "Tablets", "icon": "📱" },
                { "name": "Beauty", "icon": "💄" }
            ]);
        }
        try {
            const categories = JSON.parse(data);
            res.json(categories);
        } catch (parseError) {
            console.error('Error parsing categories JSON:', parseError);
            res.status(500).json({ error: 'Failed to parse categories' });
        }
    });
});

app.post('/categories', (req, res) => {
    const newCategory = req.body;
    console.log('Adding new category:', newCategory.name);

    if (!newCategory.name || !newCategory.icon) {
        return res.status(400).json({ error: 'Name and icon are required' });
    }

    fs.readFile(CATEGORIES_FILE, 'utf8', (err, data) => {
        let categories = [];
        if (!err) {
            try {
                categories = JSON.parse(data);
            } catch (e) {
                console.error('Error parsing categories file, initializing empty array:', e);
                categories = [];
            }
        }

        categories.push(newCategory);

        fs.writeFile(CATEGORIES_FILE, JSON.stringify(categories, null, 2), (err) => {
            if (err) {
                console.error('Error writing categories file:', err);
                return res.status(500).json({ error: 'Failed to save category' });
            }
            res.json({ success: true, message: 'Category added successfully', category: newCategory });
        });
    });
});

app.delete('/categories/bulk', (req, res) => {
    const { names } = req.body;
    if (!names || !Array.isArray(names)) {
        return res.status(400).json({ error: 'Names array required' });
    }

    fs.readFile(CATEGORIES_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read categories' });

        let categories = [];
        try {
            categories = JSON.parse(data);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse categories' });
        }

        // Filter out categories whose names are in the delete list
        categories = categories.filter(cat => !names.includes(cat.name));

        fs.writeFile(CATEGORIES_FILE, JSON.stringify(categories, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to delete categories' });
            res.json({ success: true, message: 'Categories deleted successfully' });
        });
    });
});

app.delete('/categories/:name', (req, res) => {
    const name = req.params.name;

    fs.readFile(CATEGORIES_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read categories' });

        let categories = [];
        try {
            categories = JSON.parse(data);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to parse categories' });
        }

        const initialLength = categories.length;
        categories = categories.filter(cat => cat.name !== name);

        if (categories.length === initialLength) {
            return res.status(404).json({ error: 'Category not found' });
        }

        fs.writeFile(CATEGORIES_FILE, JSON.stringify(categories, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to delete category' });
            res.json({ success: true, message: 'Category deleted' });
        });
    });
});

// Update Category
app.put('/categories/:name', (req, res) => {
    const oldName = req.params.name;
    const { name: newName, icon } = req.body;

    fs.readFile(CATEGORIES_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read categories' });
        let categories = [];
        try { categories = JSON.parse(data); } catch (e) { return res.status(500).json({ error: 'Failed to parse' }); }

        const catIndex = categories.findIndex(c => c.name === oldName);
        if (catIndex === -1) return res.status(404).json({ success: false, message: 'Category not found' });

        // Check if new name already exists (if changing name)
        if (newName && newName !== oldName && categories.some(c => c.name === newName)) {
            return res.status(400).json({ success: false, message: 'Category name already exists' });
        }

        // Update
        if (newName) categories[catIndex].name = newName;
        if (icon) categories[catIndex].icon = icon;

        fs.writeFile(CATEGORIES_FILE, JSON.stringify(categories, null, 2), (err) => {
            if (err) return res.status(500).json({ error: 'Failed to update category' });
            res.json({ success: true, message: 'Category updated' });
        });
    });
});


const ORDERS_FILE = path.join(__dirname, 'orders.json');

app.post('/purchase', async (req, res) => {
    console.log('\n--- NEW PURCHASE REQUEST ---');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const { email, productName, priceFormatted, cart } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    // Save Order Logic
    const newOrder = {
        id: Date.now().toString(), // Simple ID
        email: email,
        productName: productName, // Fallback title
        items: cart || [],
        total: priceFormatted,
        date: new Date().toISOString(),
        status: 'Active'
    };

    // Append to orders.json
    fs.readFile(ORDERS_FILE, 'utf8', (err, data) => {
        let orders = [];
        if (!err && data) {
            try { orders = JSON.parse(data); } catch (e) { }
        }
        orders.push(newOrder);
        fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), () => { });
    });

    try {
        const fromEmail = process.env.EMAIL || 'chilingaryansamvel1@gmail.com';
        console.log(`Attempting to send email from: ${fromEmail} to: ${email}`);

        if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
            throw new Error("Missing Google OAuth credentials in Environment Variables");
        }

        let itemsHtml = '';
        if (cart && cart.length > 0) {
            itemsHtml = `
                <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                    <thead>
                        <tr style="background-color: #f8f9fa;">
                            <th style="padding: 10px; border: 1px solid #dee2e6; text-align: left;">Product</th>
                            <th style="padding: 10px; border: 1px solid #dee2e6; text-align: center;">Qty</th>
                            <th style="padding: 10px; border: 1px solid #dee2e6; text-align: right;">Price</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${cart.map(item => `
                            <tr>
                                <td style="padding: 10px; border: 1px solid #dee2e6;">${item.name}</td>
                                <td style="padding: 10px; border: 1px solid #dee2e6; text-align: center;">${item.qty}</td>
                                <td style="padding: 10px; border: 1px solid #dee2e6; text-align: right;">${item.price * item.qty * 390}֏</td>
                            </tr>
                        `).join('')}
                    </tbody>
                    <tfoot>
                        <tr style="font-weight: bold;">
                            <td colspan="2" style="padding: 10px; border: 1px solid #dee2e6; text-align: right;">Total</td>
                            <td style="padding: 10px; border: 1px solid #dee2e6; text-align: right;">${priceFormatted}</td>
                        </tr>
                    </tfoot>
                </table>
            `;
        } else {
            itemsHtml = `<p>You have successfully bought: <b>${productName}</b></p><p>Total Price: <b>${priceFormatted}</b></p>`;
        }

        await transporter.sendMail({
            from: `"Yerevan Shop" <${fromEmail}>`,
            to: email,
            subject: "Purchase Confirmation - Yerevan Shop",
            text: `Thank you for your purchase!\nOrder ID: ${newOrder.id}\n\n${productName ? `Item: ${productName}\n` : ''}Total: ${priceFormatted}.\n\nWe will contact you soon for delivery details.`,
            html: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 600px; margin: auto;">
                    <h2 style="color: #28a745; text-align: center;">Thank you for your purchase!</h2>
                    <p>Hello,</p>
                    <p>We've received your order and are processing it now. Here are your order details:</p>
                    <p><strong>Order ID:</strong> #${newOrder.id}</p>
                    ${itemsHtml}
                    <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 14px; color: #555;">We will contact you soon at this email address for delivery details.</p>
                    <p style="font-size: 12px; color: #777; text-align: center;">Thank you for choosing Yerevan Shop!</p>
                </div>
            `,
        });

        res.json({ success: true, message: 'Confirmation sent to your email!' });
    } catch (error) {
        console.error("Error sending email:", error.message);
        console.error(error); // More detailed error log

        res.status(500).json({
            success: false,
            message: 'Error sending purchase confirmation: ' + error.message
        });
    }
});

// GET /orders - Retrieve orders by email
app.get('/orders', (req, res) => {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email parameter required' });

    fs.readFile(ORDERS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read orders' });

        try {
            const orders = JSON.parse(data);
            const userOrders = orders.filter(o => o.email === email).reverse(); // Newest first
            res.json(userOrders);
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse orders' });
        }
    });
});

// POST /cancel-order - Cancel an order
app.post('/cancel-order', (req, res) => {
    const { orderId, email } = req.body;
    if (!orderId || !email) return res.status(400).json({ success: false, message: 'Missing orderId or email' });

    fs.readFile(ORDERS_FILE, 'utf8', async (err, data) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to read database' });

        let orders = [];
        try { orders = JSON.parse(data); } catch (e) { return res.status(500).json({ success: false }); }

        const orderIndex = orders.findIndex(o => o.id === orderId && o.email === email);
        if (orderIndex === -1) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = orders[orderIndex];
        if (order.status === 'Cancelled') {
            return res.status(400).json({ success: false, message: 'Order is already cancelled' });
        }

        // Update status
        orders[orderIndex].status = 'Cancelled';

        // Write back
        fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), async (writeErr) => {
            if (writeErr) return res.status(500).json({ success: false, message: 'Failed to update order' });

            // Send Email Notification
            try {
                const fromEmail = process.env.EMAIL || 'chilingaryansamvel1@gmail.com';
                await transporter.sendMail({
                    from: `"Yerevan Shop" <${fromEmail}>`,
                    to: email,
                    subject: `Order Cancelled - #${orderId}`,
                    text: `Your order #${orderId} has been successfully cancelled.\n\nTotal refund amount (if applicable): ${order.total}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 600px; margin: auto;">
                            <h2 style="color: #dc3545; text-align: center;">Order Cancelled</h2>
                            <p>Hello,</p>
                            <p>We confirm that your order <strong>#${orderId}</strong> has been cancelled as requested.</p>
                            <p><strong>Total Amount:</strong> ${order.total}</p>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="font-size: 14px; color: #555;">If this was a mistake, please contact us or place a new order.</p>
                        </div>
                    `
                });
                res.json({ success: true, message: 'Order cancelled and email sent' });
            } catch (mailErr) {
                console.error("Mail error:", mailErr);
                // Return success even if email fails, because DB update worked
                res.json({ success: true, message: 'Order cancelled (Email failed)' });
            }
        });
    });
}); // Close previous route

// GET /admin/orders - Retrieve ALL orders
app.get('/admin/orders', (req, res) => {
    fs.readFile(ORDERS_FILE, 'utf8', (err, data) => {
        if (err) return res.status(500).json({ error: 'Failed to read orders' });
        try {
            const orders = JSON.parse(data).reverse(); // Newest first
            res.json(orders);
        } catch (e) {
            res.status(500).json({ error: 'Failed to parse orders' });
        }
    });
});

// POST /admin/cancel-order - Cancel ANY order
app.post('/admin/cancel-order', (req, res) => {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'Missing orderId' });

    fs.readFile(ORDERS_FILE, 'utf8', async (err, data) => {
        if (err) return res.status(500).json({ success: false, message: 'Failed to read database' });

        let orders = [];
        try { orders = JSON.parse(data); } catch (e) { return res.status(500).json({ success: false }); }

        const orderIndex = orders.findIndex(o => o.id === orderId);
        if (orderIndex === -1) {
            return res.status(404).json({ success: false, message: 'Order not found' });
        }

        const order = orders[orderIndex];
        if (order.status === 'Cancelled') {
            return res.status(400).json({ success: false, message: 'Order is already cancelled' });
        }

        // Update status
        orders[orderIndex].status = 'Cancelled';
        const userEmail = order.email;

        // Write back
        fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2), async (writeErr) => {
            if (writeErr) return res.status(500).json({ success: false, message: 'Failed to update order' });

            // Send Email Notification
            try {
                const fromEmail = process.env.EMAIL || 'chilingaryansamvel1@gmail.com';
                await transporter.sendMail({
                    from: `"Yerevan Shop" <${fromEmail}>`,
                    to: userEmail,
                    subject: `Order Cancelled by Admin - #${orderId}`,
                    text: `Your order #${orderId} has been cancelled by the administrator.\n\nTotal refund amount (if applicable): ${order.total}`,
                    html: `
                        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px; max-width: 600px; margin: auto;">
                            <h2 style="color: #dc3545; text-align: center;">Order Cancelled</h2>
                            <p>Hello,</p>
                            <p>We regret to inform you that your order <strong>#${orderId}</strong> has been cancelled by the administrator.</p>
                            <p><strong>Total Amount:</strong> ${order.total}</p>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="font-size: 14px; color: #555;">Please contact support if you have any questions.</p>
                        </div>
                    `
                });
                res.json({ success: true, message: 'Order cancelled by Admin' });
            } catch (mailErr) {
                console.error("Mail error:", mailErr);
                res.json({ success: true, message: 'Order cancelled (Email failed)' });
            }
        });
    });
});

if (require.main === module) {
    app.listen(port, () => {
        console.log(`Backend server running at http://localhost:${port}`);
    });
}

module.exports = app;
